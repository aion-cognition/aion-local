import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { identifierDecayOperation } from './identifier-decay.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  forgetNode,
  supersede,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  findEpisodeEntities,
  linkEntityMentions,
  mergeEntities,
  type EntityMergeInput,
} from '../../../infrastructure/graph/entity-queries.js';
import { closeIdentifierEntities } from '../../../infrastructure/graph/identifier-decay-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  edgePruneState,
  identifierEntityState,
} from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * One pair per eligibility rule identifier_decay's design settled on: four identifier shapes
 * eligible on their own, a plain word old and low-traffic (never touched, whatever its age), an
 * identifier too young to close, and one protected case per exemption (merge-lineage canonical
 * target, a typed-knowledge edge, and the mention floor). The last case proves the spec's own
 * claim about the undo story: a closed identifier entity mentioned again through the real
 * entity-merge and mention-link path reopens fully. A final pair contrasts that against `aion
 * forget`: the same mention on a forgotten entity leaves it exactly as forgotten as it was.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-31T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = DEFAULTS.maintenance.identifierHalfLifeDays;
const MENTION_FLOOR = DEFAULTS.maintenance.identifierMentionFloor;
/** Well past the half-life, so eligibility rests on shape and protection, not a boundary case. */
const OLD = new Date(NOW.getTime() - (HALF_LIFE_DAYS + 13) * DAY_MS);
/** Inside the half-life: the one case that must stay open on age alone. */
const RECENT = new Date(NOW.getTime() - (HALF_LIFE_DAYS - 5) * DAY_MS);

const SHA1 = '07e5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1';
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const AGENT_ID = 'code-Na1a2b3c4d5e6f';
const PATH = 'packages/core/src/identifier-decay.ts';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = DEFAULTS;

function context(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: OLD,
    properties: { text: 'text', session_id: 'session-1' },
  });
}

function mergeInput(name: string, nameNorm: string, episodeId: string): EntityMergeInput {
  return {
    name,
    nameNorm,
    type: 'tool',
    text: name,
    sourceEpisodeId: episodeId,
    extractionMethod: 'test',
    confidence: 0.8,
    occurredAt: OLD,
  };
}

/** Creates the entity and one mention from `episodeId`, stamped `at`. */
async function seedEntityWithMention(
  name: string,
  nameNorm: string,
  episodeId: string,
  at: Date,
): Promise<string> {
  await seedEpisode(episodeId);
  const [merged] = await mergeEntities(harness.driver, [mergeInput(name, nameNorm, episodeId)], at);
  const id = merged?.id;
  if (id === undefined) {
    throw new Error(`mergeEntities returned nothing for ${nameNorm}`);
  }
  await linkEntityMentions(harness.driver, {
    episodeId,
    entityIds: [id],
    now: at,
    confidence: 0.8,
    provenance: ['test'],
  });
  return id;
}

async function addMention(id: string, episodeId: string, at: Date): Promise<void> {
  await seedEpisode(episodeId);
  await linkEntityMentions(harness.driver, {
    episodeId,
    entityIds: [id],
    now: at,
    confidence: 0.8,
    provenance: ['test'],
  });
}

let shaEligibleId: string;
let uuidEligibleId: string;
let pathEligibleId: string;
let agentEligibleId: string;
let plainWordOldId: string;
let shaRecentId: string;
let canonicalTargetId: string;
let typedKnowledgeId: string;
let highMentionsId: string;
let coOccursPartnerId: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-identifier-decay-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  shaEligibleId = await seedEntityWithMention(SHA1, SHA1, 'ep-sha-eligible', OLD);
  uuidEligibleId = await seedEntityWithMention(UUID, UUID, 'ep-uuid-eligible', OLD);
  pathEligibleId = await seedEntityWithMention(PATH, PATH, 'ep-path-eligible', OLD);
  agentEligibleId = await seedEntityWithMention(AGENT_ID, AGENT_ID, 'ep-agent-eligible', OLD);
  plainWordOldId = await seedEntityWithMention('PostgreSQL', 'postgresql', 'ep-plain-old', OLD);
  shaRecentId = await seedEntityWithMention(
    'a7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'a7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'ep-sha-recent',
    RECENT,
  );

  // Protected: a merge-lineage canonical target. A throwaway duplicate is superseded into it,
  // which is what an entity-dedup merge does to the survivor.
  canonicalTargetId = await seedEntityWithMention(
    'b7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'b7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'ep-canonical-target',
    OLD,
  );
  const absorbedId = await seedEntityWithMention(
    'absorbed-duplicate',
    'absorbed-duplicate',
    'ep-absorbed',
    OLD,
  );
  await supersede(harness.driver, { oldId: absorbedId, newId: canonicalTargetId, now: OLD });

  // Protected: a typed-knowledge (CAUSES) edge.
  typedKnowledgeId = await seedEntityWithMention(
    'c7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'c7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'ep-typed-knowledge',
    OLD,
  );
  const causesTargetId = await seedEntityWithMention(
    'typed-knowledge-target',
    'typed-knowledge-target',
    'ep-typed-knowledge-target',
    OLD,
  );
  await upsertEdge(harness.driver, {
    type: 'CAUSES',
    sourceId: typedKnowledgeId,
    targetId: causesTargetId,
    strength: 1,
    confidence: 1,
    signals: ['test'],
    provenance: ['test'],
    count: 0,
    now: OLD,
  });

  // Protected: mentioned by more than the mention floor's worth of distinct episodes.
  highMentionsId = await seedEntityWithMention(
    'd7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'd7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
    'ep-high-mentions-0',
    OLD,
  );
  for (let i = 1; i <= MENTION_FLOOR; i += 1) {
    await addMention(highMentionsId, `ep-high-mentions-${String(i)}`, OLD);
  }

  // A CO_OCCURS edge onto one eligible entity, to prove the close reaches association edges too.
  coOccursPartnerId = await seedEntityWithMention(
    'co-occurs-partner',
    'co-occurs-partner',
    'ep-co-occurs-partner',
    OLD,
  );
  await upsertEdge(harness.driver, {
    type: 'CO_OCCURS',
    sourceId: shaEligibleId,
    targetId: coOccursPartnerId,
    strength: 0.5,
    confidence: 0.8,
    signals: ['test'],
    provenance: ['test'],
    count: 1,
    now: OLD,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('identifier_decay', () => {
  it('closes exactly the four identifier-shaped, unprotected, stale entities', async () => {
    const outcome = await identifierDecayOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(4);
    expect(outcome.detail).toContain('closed 4 identifier entities');
    for (const shape of ['1 sha', '1 uuid', '1 path', '1 agent_id']) {
      expect(outcome.detail).toContain(shape);
    }
  });

  it("closes the four eligible entities to the full extent of their own timeline, marked as this operation's close", async () => {
    for (const id of [shaEligibleId, uuidEligibleId, pathEligibleId, agentEligibleId]) {
      const state = await identifierEntityState(harness.driver, id);
      expect(state.forgottenAt).toBeInstanceOf(Date);
      expect(state.validUntil).toBeInstanceOf(Date);
      expect(state.closedBy).toBe('identifier_decay');
    }
  });

  it("closes an eligible entity's own MENTIONS and CO_OCCURS edges", async () => {
    const mention = await edgePruneState(
      harness.driver,
      'ep-sha-eligible',
      shaEligibleId,
      'MENTIONS',
    );
    expect(mention.validUntil).toBeInstanceOf(Date);

    const sorted = [shaEligibleId, coOccursPartnerId].sort();
    const coOccurs = await edgePruneState(harness.driver, sorted[0]!, sorted[1]!, 'CO_OCCURS');
    expect(coOccurs.validUntil).toBeInstanceOf(Date);
  });

  it('leaves the plain word untouched however old and rarely mentioned it is', async () => {
    const state = await identifierEntityState(harness.driver, plainWordOldId);
    expect(state.forgottenAt).toBeUndefined();
    expect(state.validUntil).toBeUndefined();
  });

  it('leaves an identifier too young to close alone', async () => {
    const state = await identifierEntityState(harness.driver, shaRecentId);
    expect(state.validUntil).toBeUndefined();
  });

  it('protects a merge-lineage canonical target', async () => {
    const state = await identifierEntityState(harness.driver, canonicalTargetId);
    expect(state.validUntil).toBeUndefined();
  });

  it('protects an entity carrying a typed-knowledge edge', async () => {
    const state = await identifierEntityState(harness.driver, typedKnowledgeId);
    expect(state.validUntil).toBeUndefined();
  });

  it('protects an entity mentioned by more episodes than the mention floor', async () => {
    const state = await identifierEntityState(harness.driver, highMentionsId);
    expect(state.validUntil).toBeUndefined();
  });

  it('refuses to close an entity a mention reached after the scan chose it', async () => {
    // The scan and the close are two statements. A mention landing between them makes the
    // entity fresh again, and closing it there would take the new MENTIONS edge with it.
    const rescuedId = await seedEntityWithMention(
      'b1c2d3e4f5061728394a5b6c7d8e9f00112233ff',
      'b1c2d3e4f5061728394a5b6c7d8e9f00112233ff',
      'ep-rescued-original',
      OLD,
    );
    await addMention(rescuedId, 'ep-rescued-fresh', NOW);

    const closed = await closeIdentifierEntities(harness.driver, [rescuedId], NOW, {
      mentionFloor: DEFAULTS.maintenance.identifierMentionFloor,
      mentionedBefore: new Date(
        NOW.getTime() - DEFAULTS.maintenance.identifierHalfLifeDays * 24 * 60 * 60 * 1000,
      ),
    });

    expect(closed).toEqual([]);
    const state = await identifierEntityState(harness.driver, rescuedId);
    expect(state.forgottenAt).toBeUndefined();
    expect(state.validUntil).toBeUndefined();
  });

  it('finds nothing left to close on a second run over the same substrate', async () => {
    const outcome = await identifierDecayOperation().run(context());
    expect(outcome.status).toBe('noop');
    expect(outcome.itemsAffected).toBe(0);
  });

  it(
    'a closed identifier reappearing in a new episode: the entity id is reused, a fresh open ' +
      'MENTIONS edge is written, and the entity itself returns to fully current',
    async () => {
      const freshEpisodeId = 'ep-sha-eligible-fresh-mention';
      await seedEpisode(freshEpisodeId);
      const [remerged] = await mergeEntities(
        harness.driver,
        [mergeInput(SHA1, SHA1, freshEpisodeId)],
        NOW,
      );
      expect(remerged?.id).toBe(shaEligibleId);
      expect(remerged?.created).toBe(false);

      await linkEntityMentions(harness.driver, {
        episodeId: freshEpisodeId,
        entityIds: [shaEligibleId],
        now: NOW,
        confidence: 0.8,
        provenance: ['test'],
      });

      // The write path reuses the same closed node rather than minting a new one (the
      // `(name_norm, type)` uniqueness constraint leaves it no other choice), and the new
      // episode's own MENTIONS edge is written fresh and open: `buildEdgeUpsert`'s MERGE keys
      // on (type, sourceId, targetId), and this episode id never held one before.
      const freshMention = await edgePruneState(
        harness.driver,
        freshEpisodeId,
        shaEligibleId,
        'MENTIONS',
      );
      expect(freshMention.validUntil).toBeUndefined();

      // The entity's own timeline reopens fully: `buildEntityMerge`'s `ON MATCH` branch clears
      // `forgotten_at`, `valid_until`, `tx_until`, and `closed_by` on a node the maintenance close
      // marked, the same real signal edge_prune's own reopen already answers to.
      const state = await identifierEntityState(harness.driver, shaEligibleId);
      expect(state.forgottenAt).toBeUndefined();
      expect(state.validUntil).toBeUndefined();
      expect(state.closedBy).toBeUndefined();

      // Currency-filtered reads see it again: the stage that reads "this episode's entities" to
      // feed dedup, association inference, and reinforcement no longer excludes this row, so the
      // entity the new episode mentioned is visible to every stage downstream of extraction in
      // that same run.
      const episodeEntities = await findEpisodeEntities(harness.driver, freshEpisodeId);
      expect(episodeEntities.map((entity) => entity.id)).toContain(shaEligibleId);
    },
  );

  it(
    'a forgotten entity mentioned again stays forgotten: aion forget carries no maintenance ' +
      'marker, so the reopen a decayed identifier gets never applies to it',
    async () => {
      const forgottenId = await seedEntityWithMention(
        'e7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
        'e7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
        'ep-forgotten-original',
        OLD,
      );
      await forgetNode(harness.driver, { id: forgottenId, now: OLD });

      const freshEpisodeId = 'ep-forgotten-fresh-mention';
      await seedEpisode(freshEpisodeId);
      const [remerged] = await mergeEntities(
        harness.driver,
        [
          mergeInput(
            'e7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
            'e7f5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1',
            freshEpisodeId,
          ),
        ],
        NOW,
      );
      expect(remerged?.id).toBe(forgottenId);

      const state = await identifierEntityState(harness.driver, forgottenId);
      expect(state.forgottenAt).toBeInstanceOf(Date);
      expect(state.validUntil).toBeUndefined();
      expect(state.closedBy).toBeUndefined();
    },
  );
});
