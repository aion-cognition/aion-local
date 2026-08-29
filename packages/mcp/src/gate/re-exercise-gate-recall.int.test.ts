import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryPackItem } from '@aion/protocol';
import {
  BATTERY_SUBSTRATE,
  OFF_TOPIC_BATTERY,
  ON_TOPIC_BATTERY,
  findEpisodeCognitiveNodes,
  fulltextSeeds,
  lucenePhraseQuery,
  vectorSeeds,
  withCurrency,
} from '@aion/core';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';

/**
 * Batteries 1 and 2 of the re-exercise gate, paired on purpose. EX-1's own miss queries have
 * to come back thin or empty, and the exercise's own hits have to survive the floor that made
 * that happen — half of this alone proves nothing, since a floor at 1.0 passes the first half
 * and starves every question a user would ask.
 *
 * What this adds over `recall/application/floor-battery.int.test.ts`, which measures the same
 * two batteries: the cue model runs for real rather than being stubbed to the raw query, and
 * the substrate is enriched by the shipped pipeline first, so the entity glosses and cognitive
 * nodes that filled EX-1's packs exist here to be admitted or refused.
 */

const WRITE_SESSION = 'gate-floor-write';
const READ_SESSION = 'gate-floor-read';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

const ENRICH_DEADLINE_MS = 900_000;

/**
 * How many of the on-topic probes have to put their answer at the top of its bucket. Rank is
 * RRF's job rather than the floor's, so the per-probe gate is top-3 of the bucket the answer
 * landed in; this aggregate is what catches a floor that kept every answer and buried them all.
 */
const MIN_RANK_ONE_RATE = 0.5;

/** The exercise measured 13 to 27 items and 1,161 to 1,199 of a 1,200-token budget per miss. */
const THIN_PACK_ITEMS = 2;

const substrate = new GateSubstrate('floors');
const storedIds = new Map<string, string>();
const derivedIds = new Map<string, string[]>();

type ProbeRow = {
  readonly query: string;
  readonly items: number;
  readonly bucketRank: number;
  readonly packRank: number;
};

const onTopicRows: ProbeRow[] = [];

type OffTopicRow = {
  readonly query: string;
  readonly items: number;
  /** Items admitted with `confidence: 0`, which is a node the spread reached and nothing measured. */
  readonly unmeasured: number;
};

const offTopicRows: OffTopicRow[] = [];

/** The best-ranked item that is the expected memory, plus where it sat inside its own bucket. */
function locate(
  items: readonly MemoryPackItem[],
  buckets: ReadonlyMap<string, readonly MemoryPackItem[]>,
  expected: ReadonlySet<string>,
): { bucketRank: number; packRank: number } {
  const hit = items.find((item) => expected.has(item.id));
  if (hit === undefined) {
    return { bucketRank: -1, packRank: -1 };
  }
  for (const bucket of buckets.values()) {
    const index = bucket.findIndex((item) => item.id === hit.id);
    if (index >= 0) {
      return { bucketRank: index, packRank: hit.rank };
    }
  }
  return { bucketRank: -1, packRank: hit.rank };
}

beforeAll(async () => {
  await substrate.open();

  for (const [index, episode] of BATTERY_SUBSTRATE.entries()) {
    const stored = await substrate.store(
      { observations: [episode.observation] },
      { identity: WRITE_SESSION, now: new Date(STORED_AT.getTime() + index * 60_000) },
    );
    storedIds.set(episode.id, stored.episode_id);
  }

  // The shipped pipeline over the whole substrate, so the glosses and cognitive nodes that
  // filled EX-1's packs are present. Started after every intake, so no episode is enriched
  // before its siblings are stored and the entity graph is one graph rather than ten.
  const worker = substrate.worker();
  await worker.start();
  await waitFor('the shipped pipeline to enrich the battery substrate', ENRICH_DEADLINE_MS, () =>
    Promise.resolve([...storedIds.values()].every((id) => substrate.enriched(id))),
  );
  await worker.stop();

  for (const [key, episodeId] of storedIds) {
    const nodes = await findEpisodeCognitiveNodes(substrate.driver, episodeId);
    derivedIds.set(key, [episodeId, ...nodes.map((node) => node.id)]);
  }

  // Both indexes are eventually consistent; a probe that runs while one is catching up
  // measures index lag rather than the floor.
  await waitFor('the fulltext index to cover every episode', 120_000, async () => {
    for (const episode of BATTERY_SUBSTRATE) {
      const rows = await fulltextSeeds(substrate.driver, {
        query: lucenePhraseQuery(episode.observation),
        limit: 10,
        mode: withCurrency(),
      });
      if (!rows.some((row) => row.id === storedIds.get(episode.id))) {
        return false;
      }
    }
    return true;
  });

  await waitFor('the vector index to cover every episode', 120_000, async () => {
    const [vector] = await substrate.provider.embed(['orders table sharding decision']);
    if (vector === undefined) {
      return false;
    }
    const rows = await vectorSeeds(substrate.driver, {
      vector,
      limit: BATTERY_SUBSTRATE.length * 2,
      mode: withCurrency(),
    });
    return rows.length >= BATTERY_SUBSTRATE.length;
  });
}, 1_200_000);

afterAll(async () => {
  await substrate.close();
});

describe('battery 1: the unrelated-query battery EX-1 filled to budget', () => {
  it.each(OFF_TOPIC_BATTERY)('comes back thin or empty for: %s', async (query) => {
    const result = await substrate.recall(query, { identity: READ_SESSION, now: RECALLED_AT });
    const unmeasured = result.items.filter((item) => item.confidence === 0).length;
    offTopicRows.push({ query, items: result.items.length, unmeasured });

    console.log(
      `off-topic "${query}": ${String(result.items.length)} items ` +
        `(${String(unmeasured)} with no measurement of their own), ` +
        `considered ${String(result.admission.considered)}, ` +
        `below floor ${String(result.admission.droppedBelowFloor)}, ` +
        `unmeasured ${String(result.admission.droppedUnmeasured)}, ` +
        `anchored ${String(result.admission.anchored)}, ` +
        `${String(result.pack.metadata.token_estimate)} tokens` +
        // What got in, and on what evidence. A count alone cannot tell a floor that is one
        // notch too low from a leg admitting on something that is not a measurement at all,
        // and those need opposite fixes.
        result.items
          .map(
            (item) =>
              `\n    [${item.rationale.method} ${item.confidence.toFixed(2)}] ` +
              `${item.content.slice(0, 70)}`,
          )
          .join(''),
    );

    expect(result.items.length).toBeLessThanOrEqual(THIN_PACK_ITEMS);
    // The pack has to say what it refused, not merely be short: EX-1's packs were full and
    // silent, and a thin pack with an empty report would be the same silence one size down.
    expect(result.admission.droppedBelowFloor + result.admission.droppedUnmeasured).toBeGreaterThan(
      0,
    );
    expect(result.admission.admitted).toBe(result.items.length);
    // The same counts reach the wire, not only the in-process result: a consumer reading the
    // MCP pack has to be able to tell a floor doing its job from an empty substrate.
    expect(result.pack.metadata.admission.considered).toBe(result.admission.considered);
    expect(result.pack.metadata.admission.dropped_below_floor).toBe(
      result.admission.droppedBelowFloor,
    );
    expect(result.pack.metadata.admission.vector_floor).toBe(result.admission.policy.vectorFloor);
  }, 120_000);

  // Last, so every probe above has already pushed its row. Stated as its own check because it
  // names the mechanism rather than the symptom: an off-topic pack fills when one candidate
  // anchors it and every node the spread reached then rides in with nothing measured about it.
  it('admits nothing into an off-topic pack on another item\u2019s anchor', () => {
    console.log(
      `off-topic tally: ${offTopicRows
        .map((row) => `${String(row.items)}/${String(row.unmeasured)} unmeasured`)
        .join(', ')}`,
    );

    expect(offTopicRows).toHaveLength(OFF_TOPIC_BATTERY.length);
    expect(offTopicRows.filter((row) => row.unmeasured > 0)).toEqual([]);
  });

  it('says so in the text an agent reads, not only in the structured buckets', async () => {
    const result = await substrate.recall('monsoon rainfall variability across Tamil Nadu districts', {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    expect(result.items).toHaveLength(0);
    expect(result.pack.rendered_text).toContain('No memories matched this query.');
  }, 120_000);
});

describe('battery 2: the paired on-topic battery', () => {
  it.each(ON_TOPIC_BATTERY)('still answers: $query', async (probe) => {
    const result = await substrate.recall(probe.query, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });
    const expected = new Set(derivedIds.get(probe.expects) ?? []);
    const buckets = new Map<string, readonly MemoryPackItem[]>([
      ['facts', result.pack.facts ?? []],
      ['episodes', result.pack.episodes ?? []],
      ['narratives', result.pack.narratives ?? []],
      ['preferences', result.pack.preferences ?? []],
      ['resonant', result.pack.resonant ?? []],
    ]);
    const found = locate(result.items, buckets, expected);

    onTopicRows.push({
      query: probe.query,
      items: result.items.length,
      bucketRank: found.bucketRank,
      packRank: found.packRank,
    });
    console.log(
      `on-topic "${probe.query}": ${String(result.items.length)} items, answer at bucket rank ` +
        `${String(found.bucketRank + 1)}, pack rank ${String(found.packRank)}`,
    );

    expect(result.items.length).toBeGreaterThan(0);
    expect(found.bucketRank).toBeGreaterThanOrEqual(0);
    expect(found.bucketRank).toBeLessThan(3);
  }, 120_000);

  // Last, so every probe above has already pushed its row.
  it('keeps the answer at the head of its bucket more often than not', () => {
    const first = onTopicRows.filter((row) => row.bucketRank === 0).length;
    console.log(
      `on-topic bucket-rank-1 rate: ${String(first)}/${String(onTopicRows.length)}, ` +
        `bucket ranks ${onTopicRows.map((row) => row.bucketRank + 1).join(' ')}`,
    );

    expect(onTopicRows).toHaveLength(ON_TOPIC_BATTERY.length);
    expect(first / onTopicRows.length).toBeGreaterThanOrEqual(MIN_RANK_ONE_RATE);
  });
});
