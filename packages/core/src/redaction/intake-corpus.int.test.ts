import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../infrastructure/graph/migrations.js';
import { everyStoredProperty } from '../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../infrastructure/logging/logger.js';
import { OllamaProvider } from '../infrastructure/providers/ollama-provider.js';
import { openSqliteHandle, type SqliteHandle } from '../infrastructure/sqlite/database.js';
import { listReflectionJobs } from '../infrastructure/sqlite/reflection-queue.js';
import { ReflectionDispatch } from '../reflection/application/dispatch.js';
import { handleReflection, type ReflectionIntakeDeps } from '../reflection/application/intake.js';
import { SessionManager } from '../session/session-manager.js';
import { buildFingerprint } from './fingerprint.js';
import { LEAKED_SHAPES, SURVIVING_TEXT } from './test-support/leaked-shapes.fixture.js';

/**
 * Redaction is verified where it has to hold: on what Neo4j and the queue actually hold
 * after a real intake. The exercise's own redaction pass read pack output instead and
 * reported PASS while three of these shapes sat in the substrate in plaintext, permanently,
 * since nothing is ever hard-deleted.
 */

const SURVIVORS = Object.values(SURVIVING_TEXT);

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let storedProperties: string;
let queuedPayloads: string;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-redaction-corpus-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const deps: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: new OllamaProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    }),
    dispatch: new ReflectionDispatch(),
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
  };

  for (const [index, shape] of LEAKED_SHAPES.entries()) {
    const stored = await handleReflection(deps, shape.payload, {
      identity: `redaction-corpus-${String(index)}`,
    });
    expect(stored.queued).toBe(true);
  }

  await handleReflection(
    deps,
    { observations: SURVIVORS, summary: 'material that must survive redaction' },
    { identity: 'redaction-corpus-survivors' },
  );

  storedProperties = await everyStoredProperty(harness.driver);
  queuedPayloads = JSON.stringify(listReflectionJobs(db).map((job) => job.payload));
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('redaction through a real intake, read back from the substrate', () => {
  for (const shape of LEAKED_SHAPES) {
    it(`stores no trace of ${shape.label}`, () => {
      expect(storedProperties).not.toContain(shape.material);
      expect(storedProperties).toContain(buildFingerprint(shape.rule, shape.material));
    });
  }

  it('keeps every leaked shape out of the queue payloads as well', () => {
    for (const shape of LEAKED_SHAPES) {
      expect(queuedPayloads).not.toContain(shape.material);
    }
    expect(listReflectionJobs(db)).toHaveLength(LEAKED_SHAPES.length + 1);
  });

  for (const [label, text] of Object.entries(SURVIVING_TEXT)) {
    it(`stores ${label} verbatim`, () => {
      expect(storedProperties).toContain(text);
    });
  }
});
