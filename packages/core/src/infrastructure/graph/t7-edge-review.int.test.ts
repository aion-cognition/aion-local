import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, afterAll, expect, it } from 'vitest';

import { fetchNodeEdges, fetchNodeProvenance, NODE_EDGE_PAGE_SIZE } from './node-provenance.js';
import { knewAt } from './read-modes.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';

let dir: string;
let substrate: RehearsalSubstrate;
const EARLY = '2026-09-01T00:00:00.000Z';
const LATE = '2026-09-03T00:00:00.000Z';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-edge-review-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'db.sqlite') });
  await substrate.harness.driver.executeQuery(
    'CREATE (n:AionNode:Memory {id:"hidden",tx_from:datetime($early),valid_from:datetime($early),forgotten_at:datetime($late)}) CREATE (m:AionNode:Memory {id:"other",tx_from:datetime($early),valid_from:datetime($early)}) CREATE (n)-[:CO_OCCURS {created_at:datetime($early)}]->(m)',
    { early: EARLY, late: LATE },
  );
  await substrate.harness.driver.executeQuery(
    'CREATE (n:AionNode:Memory {id:"crowded",tx_from:datetime($early),valid_from:datetime($early)}) WITH n UNWIND range(1,110) AS k CREATE (m:AionNode:Memory {id:"peer-"+toString(k),tx_from:datetime($early),valid_from:datetime($early)}) CREATE (n)-[:CO_OCCURS {created_at:datetime($early)}]->(m)',
    { early: EARLY },
  );
}, 120000);
afterAll(async () => {
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it('applies visibility to the queried endpoint as well as its neighbour', async () => {
  const { driver } = substrate.harness;
  expect(await fetchNodeProvenance(driver, 'hidden')).toBeUndefined();
  expect(
    (await fetchNodeEdges(driver, 'hidden', { mode: knewAt(new Date('2026-09-02T00:00:00.000Z')) }))
      .edges,
  ).toHaveLength(1);
  expect((await fetchNodeEdges(driver, 'hidden')).edges).toEqual([]);
});

it('enforces the hard edge page size rather than only defaulting to it', async () => {
  const page = await fetchNodeEdges(substrate.harness.driver, 'crowded', { limit: 1000 });
  expect.soft(page.edges.length).toBeLessThanOrEqual(NODE_EDGE_PAGE_SIZE);
  expect.soft(page.complete).toBe(false);
  expect.soft(page.continuation).toBeDefined();
});
