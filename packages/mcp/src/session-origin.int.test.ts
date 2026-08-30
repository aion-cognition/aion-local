import {
  countQueueJobs,
  CueCache,
  fetchItemOrigins,
  findEpisodeCognitiveNodes,
  findEpisodeEntities,
  handleRecall,
  readServedItems,
  supersede,
  withCurrency,
  type Config,
  type ItemOrigin,
  type RecallDeps,
} from '@aion/core';
import type { MemoryPack, MemoryPackItem } from '@aion/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { flatten, GateSubstrate, waitFor } from './gate/gate-substrate.fixture.js';

/**
 * The loop this file exists to close: a session says something, the stop hook reflects it into
 * the graph, and the next prompt's recall hands the session back its own words as memories it
 * has never been served. Dedup cannot catch them, because each is served exactly once.
 *
 * Run against the shipped pipeline over a live model, because what is under test is provenance
 * the enrichment stages write: the `EXTRACTED_FROM` edge on a claim, and the `MENTIONS` edge on
 * an entity. A stubbed substrate would prove the rule and nothing about the graph it reads.
 */

const WRITE_SESSION = 'origin-int-session-a';
const OTHER_SESSION = 'origin-int-session-b';

const STORED_AT = new Date('2026-06-01T10:00:00.000Z');
const CORRECTED_AT = new Date('2026-06-02T10:00:00.000Z');
const RECALLED_AT = new Date('2026-06-03T09:00:00.000Z');

const ENRICH_DEADLINE_MS = 300_000;

const QUERY = 'why did ingestion move off polling';

const OBSERVATIONS = [
  'we moved the ingestion service off polling and onto webhooks, because polling added ninety ' +
    'seconds of lag to every delivery and the on-call rotation kept paging on stale orders',
  'the webhooks cutover shipped behind a flag so ingestion could roll back to polling in one ' +
    'deploy if signature verification misbehaved',
];

/**
 * The other session correcting the record, which is what makes the corrected item outside news.
 * It names the same subjects the first episode did, so the two sessions end up sharing entities
 * as well as a topic, which is the other half of what this file checks.
 */
const CORRECTION = [
  'the ingestion service still runs polling for the payments source, because webhooks from that ' +
    'vendor are never signed and the on-call rotation had no way to tell a replay from an order',
];

const substrate = new GateSubstrate('session-origin', {
  // The subject of this file, so it runs as it ships rather than as the batteries pin it. Dedup
  // stays off: this session asks the same question several times, and every answer has to be
  // judged on where the memories came from rather than on which recall served them first.
  tune: (config) => ({
    ...config,
    recall: { ...config.recall, ownSessionFilter: true, sessionDedup: false },
  }),
});

let episodeId = '';
let ownIds: readonly string[] = [];
let entityIds: readonly string[] = [];

type Read = {
  readonly pack: MemoryPack;
  readonly items: readonly MemoryPackItem[];
};

function recallDeps(overrides: Partial<Config['recall']>): RecallDeps {
  return {
    driver: substrate.driver,
    db: substrate.db,
    sessions: substrate.sessions,
    provider: substrate.provider,
    config: { ...substrate.config, recall: { ...substrate.config.recall, ...overrides } },
    cueCache: new CueCache(),
    logger: substrate.logger,
  };
}

async function read(identity: string, overrides: Partial<Config['recall']> = {}): Promise<Read> {
  const pack = await handleRecall(
    recallDeps(overrides),
    { query: QUERY },
    { identity, now: RECALLED_AT },
  );
  return { pack, items: flatten(pack) };
}

function idsOf(result: Read): readonly string[] {
  return result.items.map((item) => item.id);
}

/** Everything the first session's episode put in the graph: the episode, its claims, its entities. */
function fromWriteSession(): readonly string[] {
  return [episodeId, ...ownIds, ...entityIds];
}

async function originOf(id: string, sessionId: string): Promise<ItemOrigin | undefined> {
  const resolved = await fetchItemOrigins(substrate.driver, {
    ids: [id],
    sessionId,
    mode: withCurrency(),
  });
  return resolved.get(id);
}

async function enrich(): Promise<void> {
  const worker = substrate.worker();
  await worker.start();
  await waitFor('the stored episodes to enrich', ENRICH_DEADLINE_MS, () => {
    const queue = countQueueJobs(substrate.db, {}, substrate.config.operational.workerMaxAttempts);
    return Promise.resolve(queue.pending === 0 && queue.claimed === 0);
  });
  await worker.stop();
}

beforeAll(async () => {
  await substrate.open();

  const stored = await substrate.store(
    { observations: [...OBSERVATIONS] },
    { identity: WRITE_SESSION, now: STORED_AT },
  );
  episodeId = stored.episode_id;

  await enrich();

  ownIds = (await findEpisodeCognitiveNodes(substrate.driver, episodeId)).map((node) => node.id);
  entityIds = (await findEpisodeEntities(substrate.driver, episodeId)).map((entity) => entity.id);
}, 900_000);

afterAll(async () => {
  await substrate.close();
});

describe('a session that asks about what it just said', () => {
  it('withholds the memories its own turns produced and leaves them for everyone else', async () => {
    // Extraction produced nothing to withhold would make every assertion below vacuous, so it
    // fails here rather than passing quietly.
    expect(ownIds.length).toBeGreaterThan(0);

    const mine = await read(WRITE_SESSION);
    const theirs = await read(OTHER_SESSION);

    const source = new Set(fromWriteSession());
    const servedToOther = idsOf(theirs).filter((id) => source.has(id));
    const servedToMine = idsOf(mine).filter((id) => source.has(id));

    // The measurement this exists for, printed rather than only asserted: run the file with
    // --reporter=verbose to read it.
    console.log(
      `own session ${String(mine.items.length)} items, ` +
        `${String(mine.pack.metadata.token_estimate)} tokens, ` +
        `suppressed_own ${String(mine.pack.metadata.suppressed_own)}; ` +
        `other session ${String(theirs.items.length)} items, ` +
        `${String(theirs.pack.metadata.token_estimate)} tokens`,
    );

    expect(servedToOther.length).toBeGreaterThan(0);
    expect(servedToMine).toEqual([]);
    expect(mine.pack.metadata.suppressed_own).toBeGreaterThan(0);
    expect(theirs.pack.metadata.suppressed_own).toBeUndefined();
    expect(mine.pack.metadata.token_estimate).toBeLessThan(theirs.pack.metadata.token_estimate);
  }, 180_000);

  it('withholds at least one claim reflection extracted from those turns', async () => {
    const mine = await read(WRITE_SESSION);
    const theirs = await read(OTHER_SESSION);

    const extracted = new Set(ownIds);
    expect(idsOf(theirs).filter((id) => extracted.has(id)).length).toBeGreaterThan(0);
    expect(idsOf(mine).filter((id) => extracted.has(id))).toEqual([]);
  }, 180_000);

  it('says so in the rendered block, not only in metadata', async () => {
    const mine = await read(WRITE_SESSION);

    expect(mine.pack.rendered_text).toContain("from this session's own turns");
  }, 180_000);

  it('serves everything again when the knob is off', async () => {
    const filtered = await read(WRITE_SESSION);
    const unfiltered = await read(WRITE_SESSION, { ownSessionFilter: false });

    const source = new Set(fromWriteSession());
    expect(idsOf(unfiltered).filter((id) => source.has(id)).length).toBeGreaterThan(0);
    expect(unfiltered.pack.metadata.suppressed_own).toBeUndefined();
    expect(unfiltered.items.length).toBeGreaterThan(filtered.items.length);
  }, 180_000);

  /**
   * Inspecting the past is a question about the record rather than a re-serve, and a session
   * asking what it wrote is the most ordinary form that question takes.
   */
  it('serves everything again on a read that inspects the past', async () => {
    const historical = await handleRecall(
      recallDeps({}),
      { query: QUERY, knew_at: RECALLED_AT.toISOString() },
      { identity: WRITE_SESSION, now: RECALLED_AT },
    );

    const source = new Set(fromWriteSession());
    expect(flatten(historical).filter((item) => source.has(item.id)).length).toBeGreaterThan(0);
    expect(historical.metadata.suppressed_own).toBeUndefined();
  }, 180_000);

  /**
   * The origin subtraction runs first and records nothing, so an item this session produced is
   * still unheard-of to the dedup record and stays eligible the moment it stops being an echo.
   */
  it('leaves no served row behind for what it withheld', async () => {
    const result = await read(WRITE_SESSION, { sessionDedup: true });

    const recorded = readServedItems(substrate.db, WRITE_SESSION);
    for (const id of fromWriteSession()) {
      expect(recorded.has(id)).toBe(false);
    }
    expect([...recorded.keys()].sort()).toEqual([...idsOf(result)].sort());
  }, 180_000);
});

/**
 * The read the subtraction stands on, asserted on its own. Which sessions a memory belongs to is
 * a property of three different edges, and a rule tested only through a pack would pass on a
 * verdict that happened to agree with the ranking.
 */
describe('what the origin read resolves', () => {
  it('names the writing session and no other for the episode it wrote', async () => {
    expect(await originOf(episodeId, WRITE_SESSION)).toEqual({ own: true, other: false });
  }, 60_000);

  it('names it for a claim extracted from that episode, which carries no session of its own', async () => {
    const claim = ownIds[0] ?? '';
    expect(claim).not.toBe('');

    expect(await originOf(claim, WRITE_SESSION)).toEqual({ own: true, other: false });
  }, 60_000);

  it('names it for an entity only that episode has mentioned', async () => {
    const entity = entityIds[0] ?? '';
    expect(entity).not.toBe('');

    expect(await originOf(entity, WRITE_SESSION)).toEqual({ own: true, other: false });
  }, 60_000);

  it('answers the other way round for the session that wrote none of it', async () => {
    expect(await originOf(episodeId, OTHER_SESSION)).toEqual({ own: false, other: true });
    expect(await originOf(ownIds[0] ?? '', OTHER_SESSION)).toEqual({ own: false, other: true });
  }, 60_000);
});

/**
 * A memory the substrate corrected is no longer only what the session said. The correction is
 * the part the conversation does not hold, so the item goes out in full and carries the lineage
 * marker with it.
 */
describe('a memory another session corrected after this one stored it', () => {
  let correctionEpisodeId = '';

  beforeAll(async () => {
    const stored = await substrate.store(
      { observations: [...CORRECTION] },
      { identity: OTHER_SESSION, now: CORRECTED_AT },
    );
    correctionEpisodeId = stored.episode_id;
    await enrich();

    await supersede(substrate.driver, {
      oldId: episodeId,
      newId: correctionEpisodeId,
      now: CORRECTED_AT,
    });
  }, 900_000);

  it('serves the closed episode back to the session that wrote it', async () => {
    const mine = await read(WRITE_SESSION);

    const closed = mine.items.find((item) => item.id === episodeId);
    expect(closed).toBeDefined();
    expect(closed?.currency).toBe('superseded');
    expect(closed?.superseded_by?.id).toBe(correctionEpisodeId);
  }, 180_000);

  /**
   * An entity outlives every episode that named it and its description accretes from all of
   * them, so a second session mentioning one makes it shared knowledge rather than an echo.
   */
  it('stops calling an entity the other session has since mentioned this session own', async () => {
    const shared = (await findEpisodeEntities(substrate.driver, correctionEpisodeId)).map(
      (entity) => entity.id,
    );
    const alsoMine = shared.filter((id) => entityIds.includes(id));

    // Which names the two episodes share is the extractor's call, so a run that shares none
    // proves nothing about the rule and says that rather than passing empty.
    expect(alsoMine.length).toBeGreaterThan(0);

    const entity = alsoMine[0] ?? '';
    expect(await originOf(entity, WRITE_SESSION)).toEqual({ own: true, other: true });
  }, 180_000);
});
