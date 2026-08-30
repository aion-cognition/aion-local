import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REDACTION_RESIDUE_MIN_RELEVANCE,
  redactionResiduePurgeOperation,
  redactionResiduePurgeRelevance,
} from './redaction-residue-purge.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  everyStoredProperty,
  nodeProperties,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
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

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-08-29T14:00:00.000Z');
const LEAKED_KEY = 'sk-ant-abcdefghij1234567890ABCDEFGHIJ';

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

const config: Config = {
  ...DEFAULTS,
  maintenance: { ...DEFAULTS.maintenance, redactionPurgeBatchSize: 10 },
};

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-redaction-purge-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function ctxFor(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: refusingProvider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('redaction_residue_purge relevance', () => {
  it('is zero with nothing leaking and clears the urgency threshold on a single leak', () => {
    const clean = healthFixture({ redaction: { scanned: 2_000, leaking: 0 } });
    expect(redactionResiduePurgeRelevance(clean)).toBe(0);

    // Thirteen out of two thousand is a share of 0.0065. Scored as a share it would need
    // roughly two and a half days of starvation boost to reach the threshold at all.
    const leaking = healthFixture({ redaction: { scanned: 2_000, leaking: 13 } });
    expect(redactionResiduePurgeRelevance(leaking)).toBeGreaterThan(
      DEFAULTS.maintenance.urgencyThreshold,
    );
    expect(redactionResiduePurgeRelevance(leaking)).toBe(REDACTION_RESIDUE_MIN_RELEVANCE);

    // A residue large enough to be proportional still orders above the floor.
    const flooded = healthFixture({ redaction: { scanned: 2_000, leaking: 1_600 } });
    expect(redactionResiduePurgeRelevance(flooded)).toBeCloseTo(0.8, 6);
  });
});

describe('redaction_residue_purge', () => {
  it('rewrites the leaking property, stamps redacted_at, and leaves id and other properties alone', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'leak-node-1',
      properties: {
        text: `the key we used was ${LEAKED_KEY}`,
        summary: 'a clean summary with nothing secret in it',
      },
      now: NOW,
    });

    const operation = redactionResiduePurgeOperation();
    const result = await operation.run(ctxFor());

    expect(result.status).toBe('applied');
    expect(result.itemsAffected).toBe(1);

    const props = await nodeProperties(harness.driver, 'leak-node-1');
    expect(props.id).toBe('leak-node-1');
    expect(props.text).not.toContain(LEAKED_KEY);
    expect(props.text).toMatch(/⟨secret:anthropic-api-key:[0-9a-f]{6}⟩/);
    expect(props.summary).toBe('a clean summary with nothing secret in it');
    expect(props.redacted_at).toBeTruthy();

    // The exercise's acceptance bar: the raw secret is nowhere in the substrate.
    expect(await everyStoredProperty(harness.driver)).not.toContain(LEAKED_KEY);
  }, 60_000);

  it('is idempotent: a second run finds nothing left to rewrite', async () => {
    const before = await nodeProperties(harness.driver, 'leak-node-1');

    const result = await redactionResiduePurgeOperation().run(ctxFor());

    expect(result.status).toBe('noop');
    expect(result.itemsAffected).toBe(0);
    const after = await nodeProperties(harness.driver, 'leak-node-1');
    // Not just "still redacted": the exact same fingerprint, not a fresh one nested in it.
    expect(after.text).toBe(before.text);
  }, 60_000);

  it('leaves an existing fingerprint intact while fingerprinting a new leak beside it', async () => {
    // The shape the detector cannot tell from a secret: an earlier fix, whose token is itself
    // `key: value`, sitting one line above a real leak that has never been redacted.
    const priorFingerprint = '⟨secret:generic-secret-assignment:abdd33⟩';
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'leak-node-nested',
      properties: { text: `api_key: ${priorFingerprint}\nanthropic_key: ${LEAKED_KEY}` },
      now: NOW,
    });

    const result = await redactionResiduePurgeOperation().run(ctxFor());
    expect(result.status).toBe('applied');

    const props = await nodeProperties(harness.driver, 'leak-node-nested');
    const text = String(props.text);
    expect(text).toContain(`api_key: ${priorFingerprint}`);
    expect(text).not.toContain(LEAKED_KEY);
    expect(text).toMatch(/⟨secret:anthropic-api-key:[0-9a-f]{6}⟩/);
    // No fingerprint holds another one: the rule id of the earlier fix is still readable.
    expect(text).not.toMatch(/⟨secret:[a-z0-9-]*⟨/);
  }, 60_000);

  it('bounds one run to redactionPurgeBatchSize nodes', async () => {
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'leak-node-2',
      properties: { text: `first leak ${LEAKED_KEY}` },
      now: NOW,
    });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: 'leak-node-3',
      properties: { text: `second leak ${LEAKED_KEY}` },
      now: NOW,
    });

    const boundedConfig: Config = {
      ...config,
      maintenance: { ...config.maintenance, redactionPurgeBatchSize: 1 },
    };
    const result = await redactionResiduePurgeOperation().run(ctxFor({ config: boundedConfig }));

    expect(result.itemsProcessed).toBe(1);
    expect(result.itemsAffected).toBe(1);

    const two = await nodeProperties(harness.driver, 'leak-node-2');
    const three = await nodeProperties(harness.driver, 'leak-node-3');
    const rewritten = [two, three].filter((props) => !String(props.text).includes(LEAKED_KEY));
    const stillRaw = [two, three].filter((props) => String(props.text).includes(LEAKED_KEY));
    expect(rewritten).toHaveLength(1);
    expect(stillRaw).toHaveLength(1);
  }, 60_000);
});
