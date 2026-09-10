import { afterAll, beforeAll, expect, it } from 'vitest';

import { PublicationCoordinator } from './coordinator.js';
import { PAIRED_POSITION_TIMEOUT_MS, readPairedPosition } from './paired-position.js';
import {
  startFamilyProbe,
  stopFamilyProbe,
  type FamilyProbe,
} from '../graph/test-support/entity-unmerge-family.fixture.js';
import { openLogger } from '../logging/logger.js';
import { coordinatorControl } from '../sqlite/publication-coordinator-store.js';

let probe: FamilyProbe;
let coordinator: PublicationCoordinator;

/** The same read-only entry point the inspection composes, against this owned pair. */
function inspection() {
  return readPairedPosition({
    driver: probe.driver,
    db: probe.db,
    timeoutMs: PAIRED_POSITION_TIMEOUT_MS,
  });
}
beforeAll(async () => {
  probe = await startFamilyProbe('aion-inspection-position-review-');
  coordinator = new PublicationCoordinator({
    driver: probe.driver,
    db: probe.db,
    handlers: [],
    logger: openLogger({ filePath: '/dev/null', level: 'error' }),
  });
  await coordinator.initialize();
}, 90_000);
afterAll(async () => {
  await stopFamilyProbe(probe);
});

it('does not certify SQLite paired to a different graph identity', async () => {
  expect((await coordinator.checkpoint()).status).toBe('ready');
  expect((await inspection()).status).toBe('ready');
  const original = coordinatorControl(probe.db).substrateId;
  try {
    probe.db.prepare('UPDATE publication_control SET substrate_id = ?').run('foreign-graph');
    const before = probe.db.prepare('SELECT total_changes() AS changes').get();
    expect((await coordinator.checkpoint()).status).toBe('unavailable');
    expect(probe.db.prepare('SELECT total_changes() AS changes').get()).toEqual(before);
    expect((await inspection()).status).toBe('unavailable');
  } finally {
    probe.db.prepare('UPDATE publication_control SET substrate_id = ?').run(original);
  }
  expect((await coordinator.checkpoint()).status).toBe('ready');
});
