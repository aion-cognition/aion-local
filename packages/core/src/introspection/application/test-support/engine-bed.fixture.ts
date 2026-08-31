import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  recordOperationResolution,
  recordOperationRun,
  recordOperationSelected,
} from '../../../infrastructure/sqlite/introspection-counters.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';
import type { Tier3Advisor, Tier3Outcome } from '../../domain/tier3.js';
import { Introspector } from '../engine.js';
import { tier3LedgerKey } from '../tier3-consult.js';

const EMBED_DIMENSION = 8;

export const NOW = new Date('2026-08-29T14:37:00.000Z');
export const NEXT_BUCKET = new Date('2026-08-29T15:02:00.000Z');
/** A later quarter-hour window inside the same hour, so an hour-bucketed claim still stands. */
export const NEXT_QUARTER = new Date('2026-08-29T14:52:00.000Z');

/** The graph, sqlite, and log handles one engine test file drives its ticks against. */
export type EngineBed = {
  readonly harness: Neo4jHarness;
  readonly db: SqliteHandle;
  readonly logger: Logger;
  readonly dataDir: string;
};

export async function startEngineBed(): Promise<EngineBed> {
  const harness = await startNeo4jHarness();
  const dataDir = mkdtempSync(join(tmpdir(), 'aion-introspector-'));
  const db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  const logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  return { harness, db, logger, dataDir };
}

/**
 * Undefined is a normal argument: teardown still runs when the setup hook threw, and failing on
 * the missing bed reports a second failure that buries the first one.
 */
export async function stopEngineBed(bed: EngineBed | undefined): Promise<void> {
  if (bed === undefined) {
    return;
  }
  await stopNeo4jHarness(bed.harness);
  bed.db.close();
  rmSync(bed.dataDir, { recursive: true, force: true });
}

/** Claims and ledger rows outlive a single test, so every case starts from an empty window. */
export function clearIntrospectionState(db: SqliteHandle): void {
  db.exec("DELETE FROM meta WHERE key LIKE 'introspection:%'");
  db.exec("DELETE FROM ops_ledger WHERE key LIKE 'intro:%'");
  db.exec("DELETE FROM ops_ledger WHERE key LIKE 'tier3:%'");
}

/** The deterministic bed: the strategic tier is off unless a test is about it. */
export const deterministicConfig: Config = {
  ...DEFAULTS,
  maintenance: {
    ...DEFAULTS.maintenance,
    tickMinutes: 15,
    urgencyThreshold: 0.2,
    tier3: false,
  },
};

export function strategicConfig(mode: 'propose' | 'act'): Config {
  return {
    ...deterministicConfig,
    maintenance: { ...deterministicConfig.maintenance, tier3: true, tier3Mode: mode },
  };
}

/** Two resolved runs, which is what the never-seen-succeed gate reads before it accepts one. */
export function seedTrackRecord(db: SqliteHandle, name: string, cycle = 1): void {
  recordOperationSelected(db, name, cycle);
  recordOperationRun(db, name, NOW.toISOString());
  recordOperationResolution(db, name, 'improved');
  recordOperationResolution(db, name, 'improved');
}

/** An advisor that always names the same operation, and counts how often it was asked. */
export function advisorFor(outcome: Tier3Outcome): Tier3Advisor & { readonly calls: () => number } {
  let calls = 0;
  const advisor = (): Promise<Tier3Outcome> => {
    calls += 1;
    return Promise.resolve(outcome);
  };
  return Object.assign(advisor, { calls: () => calls });
}

/** The second pass, stubbed at the provider the loop shares with its operations. */
export function reviewingProvider(upheld: boolean): Provider {
  return {
    embed: (): Promise<Vector[]> => Promise.reject(new Error('this caller must not embed')),
    generate: (): Promise<unknown> =>
      Promise.resolve({
        upheld,
        reason: upheld ? 'the backlog is real' : 'nine rows is not a backlog',
      }),
  };
}

export function tier3Summary(db: SqliteHandle, cycle = 1): Record<string, unknown> {
  return (getLedgerEntry(db, tier3LedgerKey(cycle))?.summary ?? {}) as Record<string, unknown>;
}

export type FakeOperation = IntrospectionOperation & { readonly calls: () => number };

/**
 * A counted stand-in for a real maintenance operation. `queueDepth` is what it reports moving,
 * so the engine's learning path is exercised against a metric it can actually see change.
 */
export function fakeOperation(
  name: string,
  overrides: Partial<IntrospectionOperation> = {},
): FakeOperation {
  let calls = 0;
  return {
    name,
    bucket: 'quarter-hour',
    relevance: () => 1,
    measure: (health) => health.plasticity.reinforcementQueueDepth,
    improves: 'lower',
    run: (): Promise<OperationOutcome> => {
      calls += 1;
      return Promise.resolve({ status: 'applied', itemsProcessed: 3, itemsAffected: 2 });
    },
    calls: () => calls,
    ...overrides,
  };
}

export type EngineOverrides = {
  readonly config?: Config;
  readonly tier3Advisor?: Tier3Advisor;
  readonly provider?: Provider;
};

/** Ticks read the snapshot list in order and hold on the last one once it runs out. */
export function engineFor(
  bed: EngineBed,
  operations: readonly IntrospectionOperation[],
  snapshots: readonly HealthSnapshot[],
  now: Date = NOW,
  overrides: EngineOverrides = {},
): Introspector {
  let index = 0;
  return new Introspector(
    {
      driver: bed.harness.driver,
      db: bed.db,
      config: overrides.config ?? deterministicConfig,
      logger: bed.logger,
      provider: overrides.provider ?? refusingProvider,
      operations,
    },
    {
      ...(overrides.tier3Advisor === undefined ? {} : { tier3Advisor: overrides.tier3Advisor }),
      observe: (options) => {
        const snapshot = snapshots[Math.min(index, snapshots.length - 1)] ?? healthFixture();
        index += 1;
        return Promise.resolve({ ...snapshot, cycle: options.cycle ?? 0 });
      },
      now: () => now,
    },
  );
}
