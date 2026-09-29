import {
  bootstrapBackbone,
  DEFAULTS,
  listOllamaModels,
  listResidentModels,
  openSqliteHandle,
  PROVIDER_KEY_ENV_VARS,
  runGraphMigrations,
  type GenerationProvider,
  type SqliteHandle,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import {
  testGenerationKey,
  testRoutesToOpenAi,
} from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapService, type AionService } from './bootstrap.js';

/**
 * The key flip at the boundary a person actually flips it: the service boots with the key and
 * again without it, against the live Ollama on this machine. What it proves is the pair of
 * claims the routing decision rests on: generation runs remotely when a key is set and queues
 * when it is not, and Ollama's memory is untouched either way, because the only model this
 * substrate asks it for is the embedder.
 *
 * Both boots run on the provider the shell selected, and the flip removes that provider's key.
 * The key is read from the environment. Nothing here writes `.env`, and the live stack is
 * untouched: this boots its own service against the test harness Neo4j and a throwaway SQLite.
 */

const PROVIDER: GenerationProvider = testRoutesToOpenAi() ? 'openai' : 'anthropic';
const KEY_VARIABLE = PROVIDER_KEY_ENV_VARS[PROVIDER];
/** The environment below names no model, so the service runs the provider's default. */
const MODEL = PROVIDER === 'openai' ? DEFAULTS.openai.model : DEFAULTS.anthropic.model;
const API_KEY = testGenerationKey();
const OLLAMA_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = DEFAULTS.models.embed;
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
    AION_SQLITE_PATH: join(dir, 'aion.sqlite'),
    AION_LOG_FILE: logPath,
    AION_LOG_LEVEL: 'debug',
    AION_MCP_PORT: '8799',
    AION_GENERATION_PROVIDER: PROVIDER,
    ...(withKey ? { [KEY_VARIABLE]: API_KEY } : {}),
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
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function messagesSince(offset: number): string[] {
  return logLines()
    .slice(offset)
    .map((line) => (JSON.parse(line) as { msg?: string }).msg ?? '');
}

/**
 * Sorted, because what this asserts is that nothing was pulled or removed. Ollama's tag
 * listing has no stable order between two calls, so comparing it as a sequence fails on the
 * order alone and says nothing about the disk.
 */
async function installedModels(): Promise<string[]> {
  return [...(await listOllamaModels(OLLAMA_URL))].sort();
}

async function residentNames(): Promise<string[]> {
  return [...(await listResidentModels(OLLAMA_URL)).map((model) => model.name)].sort();
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
    'routes every generation role to the selected provider and touches no resident model',
    async () => {
      const installedBefore = await installedModels();
      const residentBefore = await residentNames();

      const offset = logLines().length;
      let started: AionService | undefined;
      try {
        started = await bootstrapService(env(true));
      } finally {
        await started?.close();
      }

      const messages = messagesSince(offset);
      expect(messages).toContain(
        `provider routing: cue=${PROVIDER}:${MODEL} reflect=${PROVIDER}:${MODEL}`,
      );
      // The boot warms the embedder, so residency can grow by that one tag and nothing else.
      expect((await residentNames()).filter((name) => !name.startsWith(EMBED_MODEL))).toEqual(
        residentBefore.filter((name) => !name.startsWith(EMBED_MODEL)),
      );
      expect(await installedModels()).toEqual(installedBefore);
    },
    300_000,
  );

  it('queues generation with the key gone, and says so once at boot', async () => {
    const installedBefore = await installedModels();

    const offset = logLines().length;
    let started: AionService | undefined;
    try {
      started = await bootstrapService(env(false));
    } finally {
      await started?.close();
    }

    const messages = messagesSince(offset);
    // The routing line names the provider whose key is missing, and the warning names the key.
    expect(messages).toContain(
      `provider routing: cue=queued(${PROVIDER}) reflect=queued(${PROVIDER})`,
    );
    expect(
      messages.filter((message) =>
        message.startsWith(
          `generation has nowhere to run (AION_GENERATION_PROVIDER=${PROVIDER} needs ${KEY_VARIABLE})`,
        ),
      ),
    ).toHaveLength(1);
    expect(await installedModels()).toEqual(installedBefore);
  }, 300_000);
});
