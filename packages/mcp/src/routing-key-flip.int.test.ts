import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bootstrapBackbone,
  DEFAULTS,
  listOllamaModels,
  listResidentModels,
  openSqliteHandle,
  runGraphMigrations,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapService, type AionService } from './bootstrap.js';

/**
 * The key flip at the boundary a person actually flips it: the service boots with the key and
 * again without it, against the live Ollama on this machine. What it proves is the pair of
 * claims the routing decision rests on: generation follows the key, and the local models it
 * covers leave memory but not disk, so taking the key back out costs a load and not a pull.
 *
 * The key is read from the environment. Nothing here writes `.env`, and the live stack is
 * untouched: this boots its own service against the test harness Neo4j and a throwaway SQLite.
 */

const API_KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

/** Both roles name the small instruct model, so one load covers the whole flip. */
const CHAT_MODEL = DEFAULTS.models.cue;
const MEMBER_NAME = 'Key Flip Test';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dir: string;
let logPath: string;

function env(withKey: boolean): NodeJS.ProcessEnv {
  return {
    AION_NEO4J_URI: harness.uri,
    AION_NEO4J_PASSWORD: harness.password,
    AION_OLLAMA_URL: OLLAMA_URL,
    AION_CUE_MODEL: CHAT_MODEL,
    AION_REFLECT_MODEL: CHAT_MODEL,
    AION_SQLITE_PATH: join(dir, 'aion.sqlite'),
    AION_LOG_FILE: logPath,
    AION_LOG_LEVEL: 'debug',
    AION_MCP_PORT: '8799',
    ...(withKey ? { AION_ANTHROPIC_API_KEY: API_KEY } : {}),
  };
}

/**
 * Every line written so far, newest boot last; the file is append-only and written
 * synchronously. It does not exist until the first boot opens it.
 */
function logLines(): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  return readFileSync(logPath, 'utf8').split('\n').filter((line) => line.trim() !== '');
}

function messagesSince(offset: number): string[] {
  return logLines()
    .slice(offset)
    .map((line) => (JSON.parse(line) as { msg?: string }).msg ?? '');
}

async function residentNames(): Promise<string[]> {
  return (await listResidentModels(OLLAMA_URL)).map((model) => model.name);
}

async function loadChatModel(): Promise<void> {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, keep_alive: 300, stream: false }),
  });
  expect(response.ok).toBe(true);
  await response.text();
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-key-flip-'));
  logPath = join(dir, 'aion.jsonl');
  db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('booting with the key and again without it', () => {
  it.skipIf(API_KEY === '')(
    'routes generation to Anthropic and unloads the local model the key covers',
    async () => {
      const installedBefore = await listOllamaModels(OLLAMA_URL);
      await loadChatModel();
      expect(await residentNames()).toContain(CHAT_MODEL);

      const offset = logLines().length;
      let started: AionService | undefined;
      try {
        started = await bootstrapService(env(true));
      } finally {
        await started?.close();
      }

      const messages = messagesSince(offset);
      expect(messages).toContain(
        `provider routing: cue=anthropic:${DEFAULTS.anthropic.model} reflect=anthropic:${DEFAULTS.anthropic.model}`,
      );
      expect(messages.some((message) => message.startsWith('model reconciliation: unloaded'))).toBe(true);
      expect(await waitUntil(async () => !(await residentNames()).includes(CHAT_MODEL))).toBe(true);
      expect(await listOllamaModels(OLLAMA_URL)).toEqual(installedBefore);
    },
    300_000,
  );

  it(
    'restores local routing with the key gone, and reconciliation touches nothing',
    async () => {
      const installedBefore = await listOllamaModels(OLLAMA_URL);
      await loadChatModel();

      const offset = logLines().length;
      let started: AionService | undefined;
      try {
        started = await bootstrapService(env(false));
      } finally {
        await started?.close();
      }

      const messages = messagesSince(offset);
      expect(messages).toContain(
        `provider routing: cue=ollama:${CHAT_MODEL} reflect=ollama:${CHAT_MODEL}`,
      );
      // Nothing to unload means Ollama is not called at all, so no reconciliation line is written.
      expect(messages.some((message) => message.startsWith('model reconciliation:'))).toBe(false);
      expect(await residentNames()).toContain(CHAT_MODEL);
      expect(await listOllamaModels(OLLAMA_URL)).toEqual(installedBefore);
    },
    300_000,
  );
});
