import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryPackItem } from '@aion/protocol';
import {
  countQueueJobs,
  findEpisodeCognitiveNodes,
  fulltextSeeds,
  lucenePhraseQuery,
  vectorSeeds,
  withCurrency,
} from '@aion/core';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';
import { DISTRACTORS, HELD_OUT_CASES, HELD_OUT_PROBES } from './held-out-recall.fixture.js';

/**
 * Held-out recall: every claim is stored in one session and asked for in another, in words the
 * stored text does not use. The check is where the answering node lands, not whether the pack
 * came back full, because a pack of a dozen confident on-topic items that omits the answer
 * passes every count-based check there is.
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

/** Where the answer has to land. Deeper than this and the reader has scrolled past it. */
const TOP_N = 5;

/**
 * How many probes have to put a node of the answering episode's own in the top five, rather
 * than answering out of an entity gloss enrichment wrote. Below one because a gloss belongs to
 * no single episode and still answers the question, and because two cases here share a subject
 * closely enough that one phrasing sits between them.
 */
const MIN_ANSWERING_NODE_RATE = 0.8;

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
};

const rows: ProbeRow[] = [];
const methods = new Map<string, number>();

function rankOf(items: readonly MemoryPackItem[], expected: ReadonlySet<string>): number {
  const hit = items.find((item) => expected.has(item.id));
  return hit === undefined ? 0 : hit.rank;
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
  await waitFor('the shipped pipeline to work through the held-out substrate', ENRICH_DEADLINE_MS, () => {
    if ([...storedIds.values()].every((id) => substrate.enriched(id))) {
      return Promise.resolve(true);
    }
    // An episode whose extraction never returns a shape the schema accepts retries until its
    // attempts run out, and waiting past that point waits forever. A drained queue is as far
    // as the pipeline goes, and the episode is still stored, embedded and findable.
    const queue = countQueueJobs(substrate.db, {}, substrate.config.operational.workerMaxAttempts);
    return Promise.resolve(queue.pending === 0 && queue.claimed === 0);
  });
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

describe('a claim stored in one session answers the natural question asked in another', () => {
  it.each(HELD_OUT_PROBES)('answers: $question', async (probe) => {
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
    rows.push({
      key: probe.key,
      question: probe.question,
      items: result.items.length,
      rank,
      statesTheAnswer: answered,
    });

    console.log(
      `"${probe.question}": ${String(result.items.length)} items, ` +
        `answer at rank ${String(rank)}, states the answer: ${String(answered)}, ` +
        `seeds ${String(result.seeds.length)}, considered ${String(result.admission.considered)}` +
        result.items
          .slice(0, TOP_N)
          .map(
            (item) =>
              `\n    [${item.rationale.method} ${item.confidence.toFixed(2)}] ` +
              `${item.content.slice(0, 70)}`,
          )
          .join(''),
    );

    // The claim the pack has to carry, in the words the agent reads. A pack can be full,
    // confident and on-topic while saying nothing about what was asked, and item counts do not
    // separate the two.
    expect(answered).toBe(true);
  }, 180_000);

  // Last, so every probe above has already pushed its row.
  it('answers out of the episode that holds the claim, not only out of a gloss', () => {
    const found = rows.filter((row) => row.rank > 0 && row.rank <= TOP_N).length;
    console.log(
      `held-out tally: ${String(found)}/${String(rows.length)} put the answering node in the top ` +
        `${String(TOP_N)}; ranks ${rows.map((row) => row.rank).join(' ')}`,
    );

    expect(rows).toHaveLength(HELD_OUT_PROBES.length);
    expect(found / rows.length).toBeGreaterThanOrEqual(MIN_ANSWERING_NODE_RATE);
  });

  // The census that says whether retrieval is measuring meaning or matching tokens. A pack set
  // that is almost all bm25 is a lexical search with a graph attached.
  it('does not answer the whole battery on the lexical leg alone', () => {
    const census = [...methods.entries()].sort((left, right) => right[1] - left[1]);
    const packed = census.reduce((total, [, count]) => total + count, 0);
    console.log(
      `packed by method: ${census.map(([method, count]) => `${method} ${String(count)}`).join(', ')}`,
    );

    expect(packed).toBeGreaterThan(0);
    expect(methods.get('vector') ?? 0).toBeGreaterThan(methods.get('bm25') ?? 0);
  });
});
