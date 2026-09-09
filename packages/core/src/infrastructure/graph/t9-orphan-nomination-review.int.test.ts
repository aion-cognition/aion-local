import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';

import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import { clearGraphNodes } from './test-support/neo4j-harness.fixture.js';
import { findOrphanNodes } from './topology-queries.js';
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import { establishNodeSupportScopes } from '../../evidence/test-support/evidence.fixture.js';
import { readOrphanCensus } from '../../introspection/application/orphan-census.js';
import { SqliteStore } from '../sqlite/database.js';
import { recordOrphanQualification } from '../sqlite/orphan-observations.js';

let dir: string;
let sub: RehearsalSubstrate;
let store: SqliteStore;
const EARLY = new Date('2026-08-01T00:00:00.000Z');
const NOW = new Date('2026-09-08T00:00:00.000Z');
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-orphan-review-'));
  sub = await startRehearsalSubstrate({ sqlitePath: join(dir, 'db.sqlite') });
  store = new SqliteStore({ filePath: sub.sqlitePath });
}, 120000);
beforeEach(async () => {
  await clearGraphNodes(sub.harness.driver);
  store.db.prepare('DELETE FROM orphan_observations').run();
});
afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(sub);
  rmSync(dir, { recursive: true, force: true });
});

it('excludes raw turns from orphan repair nomination', async () => {
  await sub.harness.driver.executeQuery(
    'CREATE (:AionNode:Memory:Turn {id:"turn", tx_from:datetime($early),valid_from:datetime($early)})',
    { early: EARLY.toISOString() },
  );
  expect((await findOrphanNodes(sub.harness.driver, 10)).map((n) => n.id)).not.toContain('turn');
});

it('treats only visible open associations as physical support', async () => {
  await sub.harness.driver.executeQuery(
    'CREATE (a:AionNode:Memory:Insight {id:"closed",tx_from:datetime($early)}) CREATE (b:AionNode:Memory:Insight {id:"peer",tx_from:datetime($early)}) CREATE (a)-[:RELATED_TO {created_at:datetime($early),valid_until:datetime($end),tx_until:datetime($end)}]->(b) CREATE (c:AionNode:Memory:Insight {id:"open",tx_from:datetime($early)}) CREATE (d:AionNode:Memory:Insight {id:"other",tx_from:datetime($early)}) CREATE (c)-[:RELATED_TO {created_at:datetime($early)}]->(d)',
    { early: EARLY.toISOString(), end: '2026-08-15T00:00:00.000Z' },
  );
  const ids = (await findOrphanNodes(sub.harness.driver, 10)).map((n) => n.id);
  expect.soft(ids).toContain('closed');
  expect.soft(ids).not.toContain('open');
});

it('eventually examines later actionable nodes behind an unchanged unknown first page', async () => {
  await sub.harness.driver.executeQuery(
    'CREATE (:AionNode:Memory:Insight {id:"older",tx_from:datetime($early)}) CREATE (:AionNode:Memory:Insight {id:"later",tx_from:datetime($later)})',
    { early: EARLY.toISOString(), later: '2026-08-02T00:00:00.000Z' },
  );
  establishNodeSupportScopes(store.db, 'later', EARLY);
  const proof = certifyNodeSupport(store.db, 'later');
  expect(proof.support).toBe('unsupported');
  recordOrphanQualification(store.db, {
    nodeId: 'later',
    evidenceRevision: proof.evidenceRevision,
    policyRevision: 1,
    disposition: 'unsupported',
    reason: 'empty',
    now: EARLY,
  });
  const seen = new Set<string>();
  for (let i = 0; i < 4; i += 1) {
    const page = await readOrphanCensus(
      { driver: sub.harness.driver, db: store.db },
      { limit: 1, now: NOW, forgetAfterDays: 30, policyRevision: 1 },
    );
    page.entries.forEach((entry) => seen.add(entry.nodeId));
  }
  expect(seen).toContain('later');
});
