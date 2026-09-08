import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import { asOf, knewAt } from './read-modes.js';
import { findClaimSubjects } from './subject-family.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { retireEpisodeProjection } from './test-support/graph-queries.fixture.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
  establishScope,
  seedSource,
} from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../sqlite/database.js';

/**
 * What the present projection cannot answer about a subject join: which entities a claim named
 * before the edge connecting them was written, whether a relationship closed in world time is
 * still walked, and whether the archive fallback hands back a mention the records retracted.
 */

const EARLY = new Date('2026-09-08T08:00:00.000Z');
const MID = new Date('2026-09-08T09:00:00.000Z');
const LATER = new Date('2026-09-08T10:00:00.000Z');
const AFTER = new Date('2026-09-08T11:00:00.000Z');

let dir: string;
let store: SqliteStore;
let substrate: RehearsalSubstrate;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-historical-lineage-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'db.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
}, 120000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('does not traverse a mention created after a historical subject-read vantage', async () => {
  await substrate.harness.driver.executeQuery(
    "CREATE (c:AionNode:Memory:Claim {id:'historical-claim',text_norm:'atlas result',valid_from:datetime('2026-01-01T00:00:00Z'),tx_from:datetime('2026-01-01T00:00:00Z')}) CREATE (s:AionNode:Memory:Episode {id:'historical-source',valid_from:datetime('2026-01-01T00:00:00Z'),tx_from:datetime('2026-01-01T00:00:00Z')}) CREATE (e:AionNode:Memory:Entity {id:'historical-entity',name:'Atlas',name_norm:'atlas',valid_from:datetime('2026-01-01T00:00:00Z'),tx_from:datetime('2026-01-01T00:00:00Z')}) CREATE (c)-[:EXTRACTED_FROM {created_at:datetime('2026-01-01T00:00:00Z')}]->(s) CREATE (s)-[:MENTIONS {created_at:datetime('2026-09-08T10:00:00Z')}]->(e)",
  );
  expect(await findClaimSubjects(substrate.harness.driver, 'historical-claim', {})).toHaveLength(1);
  expect(
    await findClaimSubjects(
      substrate.harness.driver,
      'historical-claim',
      knewAt(new Date('2026-09-08T09:00:00Z')),
    ),
  ).toEqual([]);
});

async function seedGraph(prefix: string) {
  await substrate.harness.driver.executeQuery(
    'CREATE (c:AionNode:Memory:Claim {id:$claim,text_norm:$norm + " result",valid_from:datetime($early),tx_from:datetime($early)}) CREATE (s:AionNode:Memory:Episode {id:$source,valid_from:datetime($early),tx_from:datetime($early)}) CREATE (e:AionNode:Memory:Entity {id:$entity,name:$norm,name_norm:$norm,valid_from:datetime($early),tx_from:datetime($early)}) CREATE (c)-[:EXTRACTED_FROM {created_at:datetime($early)}]->(s) CREATE (s)-[:MENTIONS {created_at:datetime($early),valid_until:datetime($later),tx_until:datetime($later)}]->(e)',
    {
      claim: `${prefix}-claim`,
      source: `${prefix}-source`,
      entity: `${prefix}-entity`,
      // The uniqueness key on an entity's fold is real, so each case names its own subject
      // rather than a second node claiming an identity the graph already holds.
      norm: `${prefix}atlas`,
      early: EARLY.toISOString(),
      later: LATER.toISOString(),
    },
  );
}
it('applies the relationship world-time close on an as_of-only subject read', async () => {
  await seedGraph('world');
  expect(await findClaimSubjects(substrate.harness.driver, 'world-claim', asOf(MID))).toHaveLength(
    1,
  );
  expect(await findClaimSubjects(substrate.harness.driver, 'world-claim', asOf(AFTER))).toEqual([]);
});
it('does not reintroduce a retracted mention through the historical archive fallback', async () => {
  await seedGraph('fallback');
  seedSource(store.db, {
    sourceId: 'fallback-source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas result' }] },
    turnIds: ['fallback-turn'],
    now: EARLY,
  });
  for (const [node, role] of [
    ['fallback-claim', 'extraction'],
    ['fallback-entity', 'mention'],
  ]) {
    commitIncidence(store.db, {
      sourceId: 'fallback-source',
      nodeId: node!,
      role: role!,
      operationId: `incidence-${role}`,
      at: EARLY,
    });
  }
  establishScope(store.db, 'fallback-claim', 'sqlite:extraction:out', EARLY);
  establishScope(store.db, 'fallback-source', 'sqlite:mention:out', EARLY);
  commitSourceState(store.db, {
    sourceId: 'fallback-source',
    stateKind: 'unforgotten',
    operationId: 'retract-mention',
    at: LATER,
  });
  store.db
    .prepare(
      "INSERT INTO evidence_link_versions(link_id,version,prev_version,state,recorded_values_json,temporal_proof_json,observed_at,operation_key,operation_id,known_from,observed_ack_at) VALUES (?,2,1,'closed',?,'{}',?,'retract-mention','retract-mention',?,?)",
    )
    .run(
      'fallback-source:fallback-entity:mention',
      JSON.stringify({
        currency: 'closed',
        valid_until: LATER.toISOString(),
        tx_until: LATER.toISOString(),
      }),
      LATER.toISOString(),
      LATER.toISOString(),
      LATER.toISOString(),
    );
  store.db
    .prepare("UPDATE source_incidence SET currency='closed',link_version=2 WHERE role='mention'")
    .run();
  expect(
    await findClaimSubjects(substrate.harness.driver, 'fallback-claim', knewAt(AFTER)),
  ).toEqual([]);
  await retireEpisodeProjection(substrate.harness.driver, 'fallback-source');
  const r = new EvidenceResolver({
    driver: substrate.harness.driver,
    db: store.db,
    logger: { warn: () => undefined },
  });
  const read = async (at: Date) =>
    (await r.resolveSubjects(['fallback-claim'], checkedContext({ mode: knewAt(at) }))).results.get(
      JSON.stringify(['id', 'fallback-claim']),
    )?.value;
  expect.soft(await read(MID)).toHaveLength(1);
  expect.soft(await read(AFTER)).toEqual([]);
});

it('preserves world-time subjects across raw projection retirement', async () => {
  await seedGraph('relocated');
  seedSource(store.db, {
    sourceId: 'relocated-source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas result' }] },
    turnIds: ['relocated-turn'],
    now: EARLY,
  });
  for (const [node, role] of [
    ['relocated-claim', 'extraction'],
    ['relocated-entity', 'mention'],
  ]) {
    commitIncidence(store.db, {
      sourceId: 'relocated-source',
      nodeId: node!,
      role: role!,
      operationId: `incidence-${role}`,
      at: EARLY,
    });
  }
  establishScope(store.db, 'relocated-claim', 'sqlite:extraction:out', EARLY);
  establishScope(store.db, 'relocated-source', 'sqlite:mention:out', EARLY);
  commitSourceState(store.db, {
    sourceId: 'relocated-source',
    stateKind: 'unforgotten',
    operationId: 'retract-mention',
    at: LATER,
  });
  store.db
    .prepare(
      "INSERT INTO evidence_link_versions(link_id,version,prev_version,state,recorded_values_json,temporal_proof_json,observed_at,operation_key,operation_id,known_from,observed_ack_at) VALUES (?,2,1,'closed',?,'{}',?,'retract-mention','retract-mention',?,?)",
    )
    .run(
      'relocated-source:relocated-entity:mention',
      JSON.stringify({
        currency: 'closed',
        valid_until: LATER.toISOString(),
        tx_until: LATER.toISOString(),
      }),
      LATER.toISOString(),
      LATER.toISOString(),
      LATER.toISOString(),
    );
  store.db
    .prepare("UPDATE source_incidence SET currency='closed',link_version=2 WHERE role='mention'")
    .run();
  expect(
    await findClaimSubjects(substrate.harness.driver, 'relocated-claim', asOf(MID)),
  ).toHaveLength(1);
  expect(await findClaimSubjects(substrate.harness.driver, 'relocated-claim', asOf(AFTER))).toEqual(
    [],
  );
  await retireEpisodeProjection(substrate.harness.driver, 'relocated-source');
  const r = new EvidenceResolver({
    driver: substrate.harness.driver,
    db: store.db,
    logger: { warn: () => undefined },
  });
  const read = async (at: Date) =>
    (await r.resolveSubjects(['relocated-claim'], checkedContext({ mode: asOf(at) }))).results.get(
      JSON.stringify(['id', 'relocated-claim']),
    )?.value;
  expect.soft(await read(MID)).toHaveLength(1);
  expect.soft(await read(AFTER)).toEqual([]);
});

it('keeps world-time and knowledge-time bounds independent after relocation', async () => {
  await seedGraph('independent');
  await substrate.harness.driver.executeQuery(
    'MATCH (s:Episode {id:$source})-[r:MENTIONS]->() REMOVE r.tx_until',
    { source: 'independent-source' },
  );
  seedSource(store.db, {
    sourceId: 'independent-source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas result' }] },
    turnIds: ['independent-turn'],
    now: EARLY,
  });
  for (const [nodeId, role] of [
    ['independent-claim', 'extraction'],
    ['independent-entity', 'mention'],
  ] as const) {
    commitIncidence(store.db, {
      sourceId: 'independent-source',
      nodeId,
      role,
      operationId: `independent-${role}`,
      at: EARLY,
    });
  }
  establishScope(store.db, 'independent-claim', 'sqlite:extraction:out', EARLY);
  establishScope(store.db, 'independent-source', 'sqlite:mention:out', EARLY);
  // The initial evidence already knows the relationship's world-time end.
  // No later knowledge-time retraction exists.
  store.db
    .prepare('UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=?')
    .run(
      JSON.stringify({ currency: 'open', valid_until: LATER.toISOString() }),
      'independent-source:independent-entity:mention',
    );
  const mode = { knownAt: AFTER, validAt: MID };
  expect(await findClaimSubjects(substrate.harness.driver, 'independent-claim', mode)).toHaveLength(
    1,
  );
  await retireEpisodeProjection(substrate.harness.driver, 'independent-source');
  const resolver = new EvidenceResolver({
    driver: substrate.harness.driver,
    db: store.db,
    logger: { warn: () => undefined },
  });
  const result = await resolver.resolveSubjects(['independent-claim'], checkedContext({ mode }));
  expect(result.results.get(JSON.stringify(['id', 'independent-claim']))?.value).toHaveLength(1);
});

it('honors a recorded world-time start after the source projection leaves the graph', async () => {
  await seedGraph('starts');
  await substrate.harness.driver.executeQuery(
    'MATCH (s:Episode {id:$source})-[r:MENTIONS]->() SET r.valid_from=datetime($start) REMOVE r.tx_until, r.valid_until',
    { source: 'starts-source', start: LATER.toISOString() },
  );
  seedSource(store.db, {
    sourceId: 'starts-source',
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas result' }] },
    turnIds: ['starts-turn'],
    now: EARLY,
  });
  for (const [nodeId, role] of [
    ['starts-claim', 'extraction'],
    ['starts-entity', 'mention'],
  ] as const) {
    commitIncidence(store.db, {
      sourceId: 'starts-source',
      nodeId,
      role,
      operationId: role,
      at: EARLY,
    });
  }
  store.db.prepare('UPDATE evidence_link_versions SET recorded_values_json=? WHERE link_id=?').run(
    JSON.stringify({
      currency: 'open',
      valid_from: LATER.toISOString(),
      created_at: EARLY.toISOString(),
    }),
    'starts-source:starts-entity:mention',
  );
  establishScope(store.db, 'starts-claim', 'sqlite:extraction:out', EARLY);
  establishScope(store.db, 'starts-source', 'sqlite:mention:out', EARLY);
  expect(await findClaimSubjects(substrate.harness.driver, 'starts-claim', asOf(MID))).toEqual([]);
  expect(
    await findClaimSubjects(substrate.harness.driver, 'starts-claim', asOf(AFTER)),
  ).toHaveLength(1);
  await retireEpisodeProjection(substrate.harness.driver, 'starts-source');
  const resolver = new EvidenceResolver({
    db: store.db,
    driver: substrate.harness.driver,
    logger: { warn: () => undefined },
  });
  const before = await resolver.resolveSubjects(
    ['starts-claim'],
    checkedContext({ mode: asOf(MID) }),
  );
  const after = await resolver.resolveSubjects(
    ['starts-claim'],
    checkedContext({ mode: asOf(AFTER) }),
  );
  expect.soft(before.results.get('["id","starts-claim"]')?.value).toEqual([]);
  expect.soft(after.results.get('["id","starts-claim"]')?.value).toHaveLength(1);
});
