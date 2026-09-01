import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveEntities, type ResolvedEntity } from './entity-resolution.js';
import {
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  writeEntityVectors,
} from '../../../infrastructure/graph/entity-queries.js';
import { closeIdentifierEntities } from '../../../infrastructure/graph/identifier-decay-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  nodeProperties,
  storedEntities,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { identifierEntityState } from '../../../infrastructure/graph/test-support/maintenance-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  normalizeEntityName,
  type EntityType,
  type ExtractedEntity,
} from '../../domain/entity-extraction.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';

/**
 * The resolution tiers against a real server. Alias routing and the ownership rule that comes
 * before it are Cypher predicates over stored name forms, and the re-embed decision reads a
 * hash the graph holds, so all of it is a claim about the substrate rather than about the pure
 * helpers beside them.
 *
 * Resolution never embeds; the provider is here to satisfy the stage contract and fails the
 * test loudly if that ever stops being true.
 */

const EMBED_DIMENSION = 768;
const NOW = new Date('2026-08-31T00:00:00.000Z');

/** Stands in for a name embedding. `name_vec` carries no index, so its width is irrelevant here. */
const STUB_VECTOR: Vector = [0.1, 0.2, 0.3];

const PROVIDER: Provider = {
  embed: (): Promise<Vector[]> => Promise.reject(new Error('resolution must not embed')),
  generate: (): Promise<unknown> => Promise.reject(new Error('resolution must not generate')),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let ctx: StageContext;

function extracted(
  name: string,
  type: EntityType,
  extras: Partial<ExtractedEntity> = {},
): ExtractedEntity {
  return {
    name,
    nameNorm: normalizeEntityName(name),
    type,
    types: [type],
    context: 'the fixture',
    aliases: [],
    isSpeaker: false,
    ...extras,
  };
}

async function resolveOne(entity: ExtractedEntity): Promise<ResolvedEntity> {
  const resolved = await resolveEntities(ctx, [entity]);
  const first = resolved[0];
  if (first === undefined) {
    throw new Error(`nothing resolved for ${entity.nameNorm}`);
  }
  return first;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-resolution-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  ctx = {
    driver: harness.driver,
    db,
    provider: PROVIDER,
    episodeId: 'resolution-episode',
    episode: {
      id: 'resolution-episode',
      sessionId: 'resolution-session',
      text: 'the fixture episode',
      turns: [],
    },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the alias tier', () => {
  it('routes a spelling onto the identity that already answers to it', async () => {
    const seeded = await resolveOne(
      extracted('proposal_hygiene', 'tool', { aliases: ['proposal-hygiene'] }),
    );
    expect(seeded.created).toBe(true);

    const routed = await resolveOne(extracted('proposal-hygiene', 'topic'));

    expect(routed.id).toBe(seeded.id);
    expect(routed.created).toBe(false);

    const stored = (await storedEntities(harness.driver)).filter(
      (entity) => entity.nameSquash === 'proposalhygiene',
    );
    // Squash equality routes nothing at write, so the identity is one node because a record
    // named it both ways, not because two spellings squash alike.
    expect(stored).toHaveLength(1);
    expect(stored[0]?.aliasesNorm).toContain('proposal-hygiene');
    // The routed reading still counts toward the label; only the identity was decided by name.
    expect(stored[0]?.typeCounts).toBe('{"tool":1,"topic":1}');
  });

  it('mints its own identity when several current identities answer to the same alias', async () => {
    const first = await resolveOne(extracted('postgres', 'tool', { aliases: ['the store'] }));
    const second = await resolveOne(extracted('valkey', 'tool', { aliases: ['the store'] }));

    // Both nodes now answer to 'the store'; the alias tier finds two holders and refuses to
    // route onto either, so the extraction mints a third identity instead of picking one.
    const minted = await resolveOne(extracted('the store', 'tool'));

    expect(minted.created).toBe(true);
    expect(minted.id).not.toBe(first.id);
    expect(minted.id).not.toBe(second.id);
  });
});

describe('a name a maintenance close still keys', () => {
  it('routes nothing off it, so the mention reopens the identity holding it', async () => {
    const closed = await resolveOne(extracted('edge-prune', 'tool'));
    await closeIdentifierEntities(harness.driver, [closed.id], NOW);

    // A current identity holding that spelling as an alias is what the alias tier would answer
    // with, and answering it would strand the closed node holding the key forever.
    const holder = await resolveOne(extracted('edge prune', 'topic', { aliases: ['edge-prune'] }));
    expect(holder.id).not.toBe(closed.id);

    const routed = await resolveOne(extracted('edge-prune', 'tool'));

    expect(routed.id).toBe(closed.id);
    expect(await identifierEntityState(harness.driver, closed.id)).toEqual({
      forgottenAt: undefined,
      validUntil: undefined,
      closedBy: undefined,
    });
  });
});

describe('the name-vector hash', () => {
  let harborId: string;

  it('plans a re-embed on a new identity and stops once the stored hash matches', async () => {
    const first = await resolveOne(extracted('Harbor Index', 'tool'));
    harborId = first.id;
    expect(first.name?.text).toBe('harbor index');

    await writeEntityVectors(harness.driver, [
      { id: harborId, nameVector: STUB_VECTOR, nameVectorHash: first.name?.hash ?? '' },
    ]);

    const unchanged = await resolveOne(extracted('Harbor Index', 'tool'));
    expect(unchanged.id).toBe(harborId);
    expect(unchanged.name).toBeUndefined();
  });

  it('never stamps a hash the write did not store a vector for', async () => {
    const stored = (await nodeProperties(harness.driver, harborId))[
      ENTITY_NAME_VECTOR_HASH_PROPERTY
    ];

    await writeEntityVectors(harness.driver, [{ id: harborId, nameVectorHash: 'no vector here' }]);

    // The hash is the claim that the stored vector was taken over a known text. A caller that
    // hands in one without the other is answered by leaving both where they are.
    expect((await nodeProperties(harness.driver, harborId))[ENTITY_NAME_VECTOR_HASH_PROPERTY]).toBe(
      stored,
    );
  });

  it('marks the node again once an alias changes the text the vector was taken over', async () => {
    const stale = (await nodeProperties(harness.driver, harborId))[
      ENTITY_NAME_VECTOR_HASH_PROPERTY
    ];

    const aliased = await resolveOne(
      extracted('Harbor Index', 'tool', { aliases: ['harbour index'] }),
    );

    expect(aliased.id).toBe(harborId);
    expect(aliased.name?.text).toBe('harbor index\nharbour index');
    // The node still carries the hash of the name alone, so the alias makes it stale and the
    // stage plans the embed the old write-if-absent rule would never have taken.
    expect(stale).toBeTypeOf('string');
    expect(aliased.name?.hash).not.toBe(stale);

    const after = (await storedEntities(harness.driver)).find(
      (entity) => entity.nameNorm === 'harbor index',
    );
    expect(after?.aliasesNorm).toEqual(['harbour index']);
  });
});
