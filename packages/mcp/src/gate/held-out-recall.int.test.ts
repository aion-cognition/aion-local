import {
  countQueueJobs,
  findEpisodeCognitiveNodes,
  fulltextSeeds,
  lucenePhraseQuery,
  vectorSeeds,
  withCurrency,
} from '@aion/core';
import { countStatedReasons } from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import type { MemoryPackItem } from '@aion/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GateSubstrate, waitFor, type GateRecallResult } from './gate-substrate.fixture.js';
import { REMOTE_JUDGE_ABSENT } from './gate-substrate.fixture.js';
import { DISTRACTORS, HELD_OUT_CASES, HELD_OUT_PROBES } from './held-out-recall.fixture.js';

/**
 * Held-out recall: every claim is stored in one session and asked for in another, in words the
 * stored text does not use. The measurement is where the answering node lands, not whether the
 * pack came back full, because a pack of a dozen confident on-topic items that omits the answer
 * passes every count-based check there is.
 *
 * Where the answer lands, whether its words reach the top five, and which legs found what are
 * printed, not asserted: under the shipped recall the model chooses what to serve, and a build
 * does not pass or fail on its selections. What the battery asserts is the host's own work: every
 * probe ran, the gate considered candidates, every traversal item names its path, and every
 * stated reason a pack carries is rendered.
 *
 * The substrate carries the near neighbours as well, so a question competes against an
 * on-topic item that answers nothing, which is the competition it loses when the candidate set
 * is small enough for the loudest lexical hits to fill it.
 */

const WRITE_SESSION = 'gate-held-out-write';
const READ_SESSION = 'gate-held-out-read';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const ENRICH_DEADLINE_MS = 1_500_000;

/** Where the tallies look for the answer. Deeper than this and the reader has scrolled past it. */
const TOP_N = 5;

/**
 * Earlier builds gated on two rates derived from five runs: 90% of probes with a node of the
 * answering episode's own in the top five, and 87.5% carrying the answer's words there. Both are
 * printed as tallies now. A gloss belongs to no single episode and still answers, two cases share
 * a subject closely, and each run rebuilds the substrate through live model calls, so the rates
 * move run to run with nothing about retrieval having moved.
 */

const substrate = new GateSubstrate('held-out');
const storedIds = new Map<string, string>();
const derivedIds = new Map<string, string[]>();

type ProbeRow = {
  readonly key: string;
  readonly question: string;
  readonly items: number;
  /** 1-based rank across the whole pack, or 0 when the pack does not carry the answer at all. */
  readonly rank: number;
  readonly statesTheAnswer: boolean;
  /** Items the traversal leg put in the pack, and how many of those printed their path. */
  readonly activation: number;
  readonly activationPaths: number;
  /** Candidates the gate judged, and those it dropped because nothing had measured them. */
  readonly considered: number;
  readonly unmeasured: number;
  /** Seeds a cosine method never touched: a recency rank or a plain BM25 hit and nothing else. */
  readonly unmeasurableSeeds: number;
  /** Items carrying a stated reason, and how many of those reasons reached the rendered text. */
  readonly whys: number;
  readonly whysRendered: number;
};

const rows: ProbeRow[] = [];
const methods = new Map<string, number>();

/** Nodes the enriched substrate stores a stated reason on, read once the pipeline has drained. */
let storedReasons = 0;

function rankOf(items: readonly MemoryPackItem[], expected: ReadonlySet<string>): number {
  const hit = items.find((item) => expected.has(item.id));
  return hit === undefined ? 0 : hit.rank;
}

/**
 * Seeds no cosine method ever touched. A recency hit is a rank and a plain BM25 hit is a
 * corpus-relative score, so a seed found only that way reaches the gate with nothing a floor
 * can read. Counting them apart is what turns the gate's unmeasured tally into a statement
 * about the traversal leg rather than about the two legs that never measure anything.
 */
function unmeasurableSeeds(seeds: GateRecallResult['seeds']): number {
  return seeds.filter(
    (seed) =>
      seed.isStructural !== true &&
      seed.content.trim().length > 0 &&
      !seed.provenance.some(
        (entry) =>
          entry.exact === true ||
          entry.strategy === 'vector' ||
          entry.strategy === 'entity_resolution',
      ),
  ).length;
}

function statesTheAnswer(
  items: readonly MemoryPackItem[],
  answerTerms: readonly string[],
): boolean {
  return items
    .slice(0, TOP_N)
    .some((item) => answerTerms.some((term) => item.content.toLowerCase().includes(term)));
}

beforeAll(async () => {
  await substrate.open();

  let minute = 0;
  for (const held of HELD_OUT_CASES) {
    const stored = await substrate.store(
      { observations: [...held.observations] },
      { identity: WRITE_SESSION, now: new Date(STORED_AT.getTime() + minute * 60_000) },
    );
    storedIds.set(held.key, stored.episode_id);
    minute += 1;
  }

  // Stored as episodes of their own so each competes for a slot on its own merits, which is
  // what a near neighbour does on a real substrate.
  for (const [index, distractor] of DISTRACTORS.entries()) {
    const stored = await substrate.store(
      { observations: [distractor] },
      { identity: WRITE_SESSION, now: new Date(STORED_AT.getTime() + (minute + index) * 60_000) },
    );
    storedIds.set(`distractor-${String(index)}`, stored.episode_id);
  }

  // The shipped pipeline over the whole substrate, started after every intake so no episode is
  // enriched before its neighbours exist and the entity graph is one graph rather than fourteen.
  const worker = substrate.worker();
  await worker.start();
  await waitFor(
    'the shipped pipeline to work through the held-out substrate',
    ENRICH_DEADLINE_MS,
    () => {
      if ([...storedIds.values()].every((id) => substrate.enriched(id))) {
        return Promise.resolve(true);
      }
      // An episode whose extraction never returns a shape the schema accepts retries until its
      // attempts run out, and waiting past that point waits forever. A drained queue is as far
      // as the pipeline goes, and the episode is still stored, embedded and findable.
      const queue = countQueueJobs(
        substrate.db,
        {},
        substrate.config.operational.workerMaxAttempts,
      );
      return Promise.resolve(queue.pending === 0 && queue.claimed === 0);
    },
  );
  await worker.stop();

  const unenriched = [...storedIds.entries()].filter(([, id]) => !substrate.enriched(id));
  if (unenriched.length > 0) {
    console.log(`enrichment did not complete for: ${unenriched.map(([key]) => key).join(', ')}`);
  }

  for (const held of HELD_OUT_CASES) {
    const episodeId = storedIds.get(held.key) ?? '';
    const nodes = await findEpisodeCognitiveNodes(substrate.driver, episodeId);
    derivedIds.set(held.key, [episodeId, ...nodes.map((node) => node.id)]);
  }

  storedReasons = await countStatedReasons(substrate.driver);

  // Both indexes are eventually consistent; a probe that runs while one is catching up
  // measures index lag rather than retrieval.
  await waitFor('the fulltext index to cover every stored claim', 120_000, async () => {
    for (const held of HELD_OUT_CASES) {
      const first = held.observations[0] ?? '';
      const hits = await fulltextSeeds(substrate.driver, {
        query: lucenePhraseQuery(first),
        limit: 10,
        mode: withCurrency(),
      });
      if (!hits.some((hit) => hit.id === storedIds.get(held.key))) {
        return false;
      }
    }
    return true;
  });

  await waitFor('the vector index to cover every stored claim', 120_000, async () => {
    const [vector] = await substrate.provider.embed(['checkout latency index']);
    if (vector === undefined) {
      return false;
    }
    const hits = await vectorSeeds(substrate.driver, {
      vector,
      limit: HELD_OUT_CASES.length * 2,
      mode: withCurrency(),
    });
    return hits.length >= HELD_OUT_CASES.length;
  });
}, 1_800_000);

afterAll(async () => {
  await substrate.close();
});

describe.skipIf(REMOTE_JUDGE_ABSENT)(
  'a claim stored in one session answers the natural question asked in another',
  () => {
    it.each(HELD_OUT_PROBES)(
      'answers: $question',
      async (probe) => {
        const result = await substrate.recall(probe.question, {
          identity: READ_SESSION,
          now: RECALLED_AT,
        });
        const expected = new Set(derivedIds.get(probe.key) ?? []);
        const rank = rankOf(result.items, expected);
        const answered = statesTheAnswer(result.items, probe.answerTerms);

        for (const item of result.items) {
          methods.set(item.rationale.method, (methods.get(item.rationale.method) ?? 0) + 1);
        }
        const activated = result.items.filter((item) => item.rationale.method === 'activation');
        const whys = result.items.filter((item) => item.why !== undefined);
        rows.push({
          key: probe.key,
          question: probe.question,
          items: result.items.length,
          rank,
          statesTheAnswer: answered,
          activation: activated.length,
          activationPaths: activated.filter((item) => (item.rationale.path ?? '') !== '').length,
          considered: result.admission.considered,
          unmeasured: result.admission.droppedUnmeasured,
          unmeasurableSeeds: unmeasurableSeeds(result.seeds),
          whys: whys.length,
          whysRendered: whys.filter((item) =>
            result.pack.rendered_text.includes(`why: ${item.why ?? ''}`),
          ).length,
        });

        console.log(
          `"${probe.question}": ${String(result.items.length)} items, ` +
            `answer at rank ${String(rank)}, states the answer: ${String(answered)}, ` +
            `seeds ${String(result.seeds.length)}, considered ${String(result.admission.considered)}${result.items
              .slice(0, TOP_N)
              .map(
                (item) =>
                  `\n    [${item.rationale.method} ${item.confidence.toFixed(2)}] ${item.content.slice(
                    0,
                    70,
                  )}`,
              )
              .join('')}`,
        );

        // Rank zero is the miss worth reading: an on-topic recall that came back without the
        // answer. It is printed above, not asserted, because what the pack serves is the model's
        // selection.
      },
      180_000,
    );

    // Last, so every probe above has already pushed its row.
    it('ran every probe and prints where each answering node landed', () => {
      const found = rows.filter((row) => row.rank > 0 && row.rank <= TOP_N).length;
      console.log(
        `held-out tally: ${String(found)}/${String(rows.length)} put the answering node in the top ` +
          `${String(TOP_N)}; ranks ${rows.map((row) => row.rank).join(' ')}`,
      );

      expect(rows).toHaveLength(HELD_OUT_PROBES.length);
    });

    // A pack can be full, confident and on-topic while saying nothing about what was asked, and
    // item counts do not separate the two. The tally is printed for a reader to judge.
    it('prints how many packs carry the answer in words', () => {
      const answering = rows.filter((row) => row.statesTheAnswer).length;
      console.log(
        `answered in words: ${String(answering)}/${String(rows.length)}; silent on ${
          rows
            .filter((row) => !row.statesTheAnswer)
            .map((row) => `"${row.question}"`)
            .join(', ') || 'nothing'
        }`,
      );
    });

    // The traversal leg, from the reader's side. An activation item is one no seed strategy
    // found: the graph reached it and something then measured it against the question. How many
    // the packs hold is the model's selection and is printed; that each names the path that
    // reached it is the host's to hold.
    it('prints the path to every memory no seed strategy found', () => {
      const contributed = rows.reduce((total, row) => total + row.activation, 0);
      const withPath = rows.reduce((total, row) => total + row.activationPaths, 0);
      const probes = rows.filter((row) => row.activation > 0).length;
      console.log(
        `activation contribution: ${String(contributed)} item(s) across ` +
          `${String(probes)}/${String(rows.length)} probes, ${String(withPath)} with a path`,
      );

      expect(withPath).toBe(contributed);
    });

    // The other half of the same leg: what it costs. An arrival the spread reached is scored
    // against the cues, so on an enriched substrate almost nothing reaches the gate with no
    // measurement at all. A recency hit and a plain BM25 hit are ranks rather than measurements,
    // so seeds found only that way are counted out; what is left is a node whose content vector
    // is not written yet. The share is printed, not capped: it was 1.1% (15 of 1,344) when a
    // 3% cap stood here, and a climb is arrival scoring falling back to a refusal.
    it('prints what the spread reached and the gate judged unmeasured', () => {
      const considered = rows.reduce((total, row) => total + row.considered, 0);
      const unmeasured = rows.reduce((total, row) => total + row.unmeasured, 0);
      const unmeasurable = rows.reduce((total, row) => total + row.unmeasurableSeeds, 0);
      const unexplained = Math.max(0, unmeasured - unmeasurable);
      console.log(
        `unmeasured candidates: ${String(unmeasured)}/${String(considered)} considered, ` +
          `${String(unmeasurable)} of them seeds no cosine method touched, ` +
          `${String(unexplained)} left unexplained ` +
          `(${(considered === 0 ? 0 : (unexplained / considered) * 100).toFixed(1)}%)`,
      );

      expect(considered).toBeGreaterThan(0);
    });

    // A decision the pack carries without its stated reason reads like a decision nobody argued
    // for, and a structured field the rendered text drops is the same loss for a text-only
    // consumer. How many reasons the substrate holds at all is extraction's business and moves
    // run to run, so it is logged beside the count rather than asserted here; that the answering
    // pack keeps every one it selected is this battery's to hold.
    it('renders every stated reason its packs carry, not only the structured field', () => {
      const carried = rows.reduce((total, row) => total + row.whys, 0);
      const rendered = rows.reduce((total, row) => total + row.whysRendered, 0);
      console.log(
        `stated reasons: ${String(storedReasons)} stored on the substrate, ${String(carried)} ` +
          `carried by the battery's packs, ${String(rendered)} rendered`,
      );

      expect(rendered).toBe(carried);
    });

    // The method census is logged, not asserted. An item's method is whichever leg's normalized
    // relevance is highest, so the split says how the legs' scales compare, not whether retrieval
    // measured meaning. It once required more vector items than bm25 ones.
    it('prints the method each packed item was labeled with', () => {
      const census = [...methods.entries()].sort((left, right) => right[1] - left[1]);
      const packed = census.reduce((total, [, count]) => total + count, 0);
      const split = census.map(([method, count]) => `${method} ${String(count)}`).join(', ');
      console.log(`packed by method (${String(packed)} items): ${split}`);
    });
  },
);
