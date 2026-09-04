import {
  CO_OCCURS_TYPE,
  ContextVectorStage,
  ENTITY_MENTION_TYPE,
  OFF_TOPIC_BATTERY,
  PIPELINE_VERSION,
  RESONANCE_PATH,
  cosineSimilarity,
  fulltextSeeds,
  loadEpisodeContext,
  lucenePhraseQuery,
  upsertEdge,
  vectorSeeds,
  withCurrency,
  writeStampedNode,
} from '@aion/core';
import { contextVector } from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import type { MemoryPack, MemoryPackItem } from '@aion/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ANCHOR_WORLD,
  DISTRACTOR_WORLD,
  RESONANCE_QUERY,
  SPACER_EPISODES,
  TARGET_WORLD,
  type ResonanceWorld,
} from './context-resonance.fixture.js';
import { GateSubstrate, waitFor, REMOTE_JUDGE_ABSENT  } from './gate-substrate.fixture.js';

/**
 * The second pass, on the shipped read path and in the embedding space the service actually
 * uses. A memory the query shares no words with, that no seed strategy finds and no traversal
 * reaches, comes back because the shape of its neighborhood matches the shape of what the
 * first pass activated. Everything about it that a pack can print is measured here: the
 * bucket it lands in, the method and path it explains itself with, the similarity it was
 * admitted on, and the memory whose neighborhood has a different shape staying out.
 *
 * The crews are written directly rather than extracted, for the reason the context-vector
 * stage's own test gives: what needs proving is the centroid, the index and the bucket, not
 * whether a model names the same three people twice. Their vectors come from the shipped embed
 * model all the same, so the similarity that admits the target is one measured in the space
 * every other number in this repo is measured in, not in a hand-made one.
 *
 * The seed budget is narrowed to four. At the shipped budget every node in a substrate this
 * size is a seed, the exclusion set swallows the whole graph, and a run that returns nothing
 * resonant proves nothing about resonance.
 */

const READ_SESSION = 'gate-resonance-read';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-02T09:00:00.000Z');

/** What the substrate is allowed to seed, which is what keeps the target out of the first pass. */
const SEED_BUDGET = 4;

const substrate = new GateSubstrate('resonance', {
  tune: (config) => ({
    ...config,
    contextResonance: { ...config.contextResonance, seedLimit: SEED_BUDGET },
  }),
});

const episodeIds = new Map<string, string>();
const entityIds = new Map<string, string[]>();

function idsOf(world: ResonanceWorld): string[] {
  return [episodeIds.get(world.key) ?? '', ...(entityIds.get(world.key) ?? [])];
}

function bucketsOf(pack: MemoryPack): ReadonlyMap<string, readonly MemoryPackItem[]> {
  return new Map<string, readonly MemoryPackItem[]>([
    ['facts', pack.facts ?? []],
    ['episodes', pack.episodes ?? []],
    ['narratives', pack.narratives ?? []],
    ['preferences', pack.preferences ?? []],
    ['resonant', pack.resonant ?? []],
  ]);
}

/** One world: its episode through the shipped intake, then the people it names around it. */
async function writeWorld(world: ResonanceWorld, at: Date): Promise<void> {
  const stored = await substrate.store(
    { observations: [world.observation] },
    { identity: world.session, now: at },
  );
  episodeIds.set(world.key, stored.episode_id);

  const vectors = await substrate.provider.embed(world.crew.map((member) => member.description));
  const written: string[] = [];
  for (const [index, member] of world.crew.entries()) {
    const vector = vectors[index];
    if (vector === undefined) {
      throw new Error(`no vector for ${member.name}`);
    }
    const id = `${world.key}-crew-${String(index)}`;
    await writeStampedNode(substrate.driver, {
      label: 'Entity',
      id,
      now: at,
      occurredAt: at,
      properties: {
        name: member.name,
        name_norm: member.name.toLowerCase(),
        type: 'person',
        text: member.description,
        content_vec: [...vector],
      },
    });
    await upsertEdge(substrate.driver, {
      type: ENTITY_MENTION_TYPE,
      sourceId: stored.episode_id,
      targetId: id,
      strength: 1,
      confidence: 0.9,
      signals: ['episodic'],
      provenance: ['gate-fixture'],
      count: 1,
      now: at,
    });
    written.push(id);
  }

  // The people named together in one episode, linked as the association stage links them.
  // A crew that co-occurs is what makes each member's own neighborhood the crew rather than
  // the episode alone, which is the shape the second pass compares.
  for (const [index, id] of written.entries()) {
    for (const other of written.slice(index + 1)) {
      await upsertEdge(substrate.driver, {
        type: CO_OCCURS_TYPE,
        sourceId: id,
        targetId: other,
        strength: 1,
        confidence: 0.9,
        signals: ['episodic'],
        provenance: ['gate-fixture'],
        count: 1,
        now: at,
      });
    }
  }
  entityIds.set(world.key, written);
}

/** The pipeline's last stage over one episode's neighborhood, run as the service runs it. */
async function summarizeNeighborhood(episodeId: string, at: Date): Promise<void> {
  const episode = await loadEpisodeContext(substrate.driver, episodeId);
  if (episode === undefined) {
    throw new Error(`episode ${episodeId} is not readable`);
  }
  const outcome = await new ContextVectorStage().run({
    driver: substrate.driver,
    db: substrate.db,
    provider: substrate.provider,
    episodeId,
    episode,
    logger: substrate.logger,
    now: at,
    occurredAt: at,
    pipelineVersion: PIPELINE_VERSION,
  });
  expect(outcome.status).toBe('ok');
}

beforeAll(async () => {
  await substrate.open();

  // Oldest first, and the anchor last, so the recency leg reaches for the anchor's world and
  // never for the target's. The spacers sit between their sessions because sessions chain: two
  // of them put the target's session out of the spread's hop budget.
  let minute = 0;
  const at = (): Date => new Date(STORED_AT.getTime() + minute * 60_000);

  await writeWorld(TARGET_WORLD, at());
  minute += 1;
  await writeWorld(DISTRACTOR_WORLD, at());
  minute += 1;
  for (const spacer of SPACER_EPISODES) {
    await substrate.store(
      { observations: [spacer.observation] },
      { identity: spacer.session, now: at() },
    );
    minute += 1;
  }
  await writeWorld(ANCHOR_WORLD, at());

  for (const world of [TARGET_WORLD, DISTRACTOR_WORLD, ANCHOR_WORLD]) {
    await summarizeNeighborhood(episodeIds.get(world.key) ?? '', at());
  }

  await waitFor('the context vector index to cover every world', 120_000, async () => {
    for (const world of [TARGET_WORLD, DISTRACTOR_WORLD, ANCHOR_WORLD]) {
      if ((await contextVector(substrate.driver, episodeIds.get(world.key) ?? '')) === undefined) {
        return false;
      }
    }
    return true;
  });
  // Both indexes are eventually consistent; a probe that runs while one is catching up measures
  // index lag rather than the second pass.
  await new Promise((resolve) => {
    setTimeout(resolve, 2000);
  });
}, 600_000);

afterAll(async () => {
  await substrate.close();
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('a memory the query shares no words with reaches the pack by the shape of its neighborhood', () => {
  it('leaves the target out of reach of the content leg and the keyword leg', async () => {
    const [queryVector] = await substrate.provider.embed([RESONANCE_QUERY]);
    const [targetVector] = await substrate.provider.embed([TARGET_WORLD.observation]);
    if (queryVector === undefined || targetVector === undefined) {
      throw new Error('the embed model returned no vector for the query');
    }

    const nearest = await vectorSeeds(substrate.driver, {
      vector: queryVector,
      limit: SEED_BUDGET,
      mode: withCurrency(),
    });
    const lexical = await fulltextSeeds(substrate.driver, {
      query: lucenePhraseQuery(RESONANCE_QUERY),
      limit: 10,
      mode: withCurrency(),
    });
    const targetId = episodeIds.get(TARGET_WORLD.key) ?? '';

    console.log(
      `target content cosine to the query: ` +
        `${cosineSimilarity(queryVector, targetVector).toFixed(3)} against an admission floor of ${String(
          substrate.config.recall.vectorAdmissionFloor,
        )}`,
    );

    expect(cosineSimilarity(queryVector, targetVector)).toBeLessThan(
      substrate.config.recall.vectorAdmissionFloor,
    );
    expect(nearest.map((row) => row.id)).not.toContain(targetId);
    expect(lexical.map((row) => row.id)).not.toContain(targetId);
  }, 120_000);

  /**
   * The band `contextResonance.contextSearchThreshold` sits in, measured rather than assumed.
   * The search runs from a centroid over what the first pass admitted, which is this query's
   * anchor world, so the two readings against that world's own neighborhood shape are the two
   * distributions the threshold has to separate: the memory whose crew has the same shape, and
   * the memory whose crew has a different one.
   */
  it('measures the shape distance to the target against the shape distance to the distractor', async () => {
    const anchor = await contextVector(substrate.driver, episodeIds.get(ANCHOR_WORLD.key) ?? '');
    const target = await contextVector(substrate.driver, episodeIds.get(TARGET_WORLD.key) ?? '');
    const distractor = await contextVector(
      substrate.driver,
      episodeIds.get(DISTRACTOR_WORLD.key) ?? '',
    );
    if (anchor === undefined || target === undefined || distractor === undefined) {
      throw new Error('a world reached the read path with no context vector');
    }

    const matched = cosineSimilarity(anchor, target);
    const mismatched = cosineSimilarity(anchor, distractor);
    const threshold = substrate.config.contextResonance.contextSearchThreshold.toFixed(2);
    console.log(
      `neighborhood shape against the anchor: target ${matched.toFixed(3)}, distractor ${mismatched.toFixed(3)}, threshold ${threshold}`,
    );

    expect(matched).toBeGreaterThan(mismatched);
  }, 120_000);

  it('surfaces the target in the resonant bucket and in no other', async () => {
    const result = await substrate.recall(RESONANCE_QUERY, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });
    const targetId = episodeIds.get(TARGET_WORLD.key) ?? '';

    console.log(
      `resonant bucket: ${String(result.pack.resonant?.length ?? 0)} item(s), ` +
        `seeds ${String(result.seeds.length)}, admitted ${String(result.admission.admitted)}${(
          result.pack.resonant ?? []
        )
          .map(
            (item) =>
              `\n    [${item.rationale.method} ${item.confidence.toFixed(3)}] ${item.content.slice(
                0,
                70,
              )}`,
          )
          .join('')}`,
    );

    // Not found by a seed strategy and not reached by the spread: if either had, the second
    // pass would have excluded it and the bucket would be empty.
    expect(result.seeds.map((seed) => seed.id)).not.toContain(targetId);
    expect(result.pack.resonant?.map((item) => item.id)).toContain(targetId);
    for (const [name, bucket] of bucketsOf(result.pack)) {
      if (name === 'resonant') {
        continue;
      }
      expect(bucket.map((item) => item.id)).not.toContain(targetId);
    }
  }, 120_000);

  it('explains every resonant item as a shape match above the context threshold', async () => {
    const result = await substrate.recall(RESONANCE_QUERY, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });
    const resonant = result.pack.resonant ?? [];

    expect(resonant.length).toBeGreaterThan(0);
    for (const item of resonant) {
      expect(item.rationale.method).toBe('resonance');
      expect(item.rationale.path).toBe(RESONANCE_PATH);
      // Admitted by the algorithm's own bar, which is a cosine between two neighborhoods and
      // has nothing to say about the content floors.
      expect(item.confidence).toBeGreaterThanOrEqual(
        substrate.config.contextResonance.contextSearchThreshold,
      );
    }
  }, 120_000);

  // The bucket is a second way into the pack, never a second copy of it. The stage excludes
  // what the first pass produced and the pack drops content twins, and this is the check that
  // catches a regression in either of them.
  it('never lets one memory reach the pack twice under two rationales', async () => {
    const result = await substrate.recall(RESONANCE_QUERY, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });
    const resonant = new Set((result.pack.resonant ?? []).map((item) => item.id));

    for (const [name, bucket] of bucketsOf(result.pack)) {
      if (name === 'resonant') {
        continue;
      }
      for (const item of bucket) {
        expect(resonant.has(item.id)).toBe(false);
      }
    }
  }, 120_000);

  it('leaves the memory whose neighborhood has a different shape out of every bucket', async () => {
    const result = await substrate.recall(RESONANCE_QUERY, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    for (const id of idsOf(DISTRACTOR_WORLD)) {
      expect(result.items.map((item) => item.id)).not.toContain(id);
    }
  }, 120_000);

  it('still answers the question it was asked, so the second pass adds rather than swaps', async () => {
    const result = await substrate.recall(RESONANCE_QUERY, {
      identity: READ_SESSION,
      now: RECALLED_AT,
    });

    expect(result.items.map((item) => item.id)).toContain(episodeIds.get(ANCHOR_WORLD.key));
    expect(result.admission.anchored).toBe(true);
  }, 120_000);
});

/**
 * Resonance cannot fire on a query the first pass could not answer: the centroid would be the
 * shape of whatever the recency leg happened to return, and searching from it is how an
 * off-topic pack fills itself with memories nothing measured.
 */
describe.skipIf(REMOTE_JUDGE_ABSENT)('an off-topic query gets no resonant bucket at all', () => {
  it.each(OFF_TOPIC_BATTERY)(
    'stays quiet for: %s',
    async (query) => {
      const result = await substrate.recall(query, { identity: READ_SESSION, now: RECALLED_AT });

      console.log(
        `off-topic "${query}": ${String(result.items.length)} item(s), ` +
          `anchored ${String(result.admission.anchored)}, ` +
          `resonant ${String(result.pack.resonant?.length ?? 0)}`,
      );

      expect(result.pack.resonant).toBeUndefined();
    },
    120_000,
  );
});
