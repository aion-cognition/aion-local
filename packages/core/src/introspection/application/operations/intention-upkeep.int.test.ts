import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { intentionUpkeepLedgerKey, intentionUpkeepOperation } from './intention-upkeep.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  BITEMPORAL_PROPERTIES,
  CLOSURE_PROVENANCE_PROPERTY,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { CLOSED_BY_INTENTION_UPKEEP } from '../../../infrastructure/graph/intention-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The aging half of an intention's life, against a real graph: the horizon a Goal is written
 * with, the sweep that closes it a whole horizon later, and the reopen that undoes the close.
 */

const EMBED_DIMENSION = 8;

const HORIZON_DAYS = 30;

/** The clock the sweep runs on. Every episode below is dated backwards from it. */
const NOW = new Date('2026-12-01T00:00:00.000Z');

const DAY_MS = 24 * 60 * 60 * 1000;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

async function seedIntention(id: string, occurredAt: Date): Promise<string> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt,
    properties: { text: `episode ${id}`, session_id: 'session-intentions' },
  });
  const written = await writeCognitiveNode(harness.driver, {
    episodeId: id,
    label: 'Goal',
    text: `We plan to finish the ${id} migration.`,
    occurredAt,
    now: NOW,
    intentionHorizonDays: HORIZON_DAYS,
  });
  return written.node.id;
}

function context(config: Config = DEFAULTS): OperationContext {
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

function withHorizon(days: number): Config {
  return { ...DEFAULTS, temporal: { ...DEFAULTS.temporal, intentionHorizonDays: days } };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-intention-upkeep-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('intention_upkeep', () => {
  it('closes an intention stale by a whole horizon and leaves a merely expired one open', async () => {
    // Written 70 days ago, so its horizon fell 40 days ago: a whole horizon past and then some.
    const stale = await seedIntention('ep-intent-stale', daysBefore(70));
    // Written 40 days ago: expired 10 days ago, which the read side already says on its own.
    const expired = await seedIntention('ep-intent-expired', daysBefore(40));
    // Written 5 days ago, still inside its horizon.
    const fresh = await seedIntention('ep-intent-fresh', daysBefore(5));

    const outcome = await intentionUpkeepOperation().run(context(withHorizon(HORIZON_DAYS)));

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsAffected).toBe(1);
    const closed = await nodeProperties(harness.driver, stale);
    expect(closed[BITEMPORAL_PROPERTIES.validUntil]).toEqual(NOW);
    expect(closed[BITEMPORAL_PROPERTIES.txUntil]).toEqual(NOW);
    // A forget is a person's act, and `aion unsupersede` does not undo one.
    expect(closed[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(
      (await nodeProperties(harness.driver, expired))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
    expect(
      (await nodeProperties(harness.driver, fresh))[BITEMPORAL_PROPERTIES.validUntil],
    ).toBeUndefined();
  });

  it('stamps the close with the operation that made it and records a ledger row per close', async () => {
    const stale = await seedIntention('ep-intent-stamped', daysBefore(90));

    await intentionUpkeepOperation().run(context(withHorizon(HORIZON_DAYS)));

    const properties = await nodeProperties(harness.driver, stale);
    expect(properties[CLOSURE_PROVENANCE_PROPERTY]).toBe(CLOSED_BY_INTENTION_UPKEEP);
    const entry = getLedgerEntry(db, intentionUpkeepLedgerKey(stale));
    expect(entry).toBeDefined();
    expect(entry?.summary).toEqual({
      closedAt: NOW.toISOString(),
      validHorizon: new Date(daysBefore(90).getTime() + HORIZON_DAYS * DAY_MS).toISOString(),
    });
  });

  it('gives the intention back when aion unsupersede reopens it', async () => {
    const stale = await seedIntention('ep-intent-reopened', daysBefore(120));
    await intentionUpkeepOperation().run(context(withHorizon(HORIZON_DAYS)));

    const reopened = await unsupersedeNode(harness.driver, { id: stale, now: NOW });

    expect(reopened.justReopened).toBe(true);
    const properties = await nodeProperties(harness.driver, stale);
    expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(properties[BITEMPORAL_PROPERTIES.txUntil]).toBeUndefined();
  });

  it('reads nothing on a graph whose intentions are all inside their horizon', async () => {
    await seedIntention('ep-intent-current', daysBefore(1));

    const outcome = await intentionUpkeepOperation().run(context(withHorizon(365)));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'no intention has been past its horizon for a whole horizon',
    });
  });
});
