import {
  bootstrapBackbone,
  INTEGRATE_JOB_TYPE,
  openSqliteHandle,
  runGraphMigrations,
  type SqliteHandle,
  DEFAULTS,
} from '@aion/core';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '@aion/core/infrastructure/graph/test-support/neo4j-harness.fixture.js';
import {
  testGenerationEnv,
  testGenerationKey,
} from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import {
  listReflectionJobs,
  type ReflectionJob,
} from '@aion/core/infrastructure/sqlite/reflection-queue.js';
import { bootstrapService, MCP_PATH, type AionService } from '@aion/mcp';
import { ReflectionOutputSchema } from '@aion/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runLast } from './last.js';

/**
 * Whether this run can enrich at all. The service generates on the route the shell selected
 * (`testGenerationEnv`), and with no key for that route its enrichment waits for one by design.
 * The pack this file compares does not depend on enrichment, so a keyless run waits for the queue
 * to go quiet rather than to empty.
 */
const KEYLESS = testGenerationKey() === '';

/**
 * `aion last --json` must reproduce, byte-for-byte on content, the pack the MCP client
 * actually received. This drives a real client against a real `bootstrapService` over
 * loopback HTTP, then points the CLI's own code path at the same SQLite file the service
 * wrote to, so both readers agree with what is really on disk.
 */

const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const OBSERVATION = 'we picked webhooks for the ingestion service because polling was too slow';
const QUERY = 'why did we pick webhooks for ingestion';

let harness: Neo4jHarness;
let dir: string;
let migrationDb: SqliteHandle;
let sqlitePath: string;
let started: AionService;
let sessionId: string;
let mcpPack: unknown;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits out the queue the reflection call filled, so nothing publishes during the recall. */
/**
 * With a key the queue empties. Without one it goes quiet instead: the worker gives back the
 * enrichment it could not run, unspent, and no row is claimed.
 */
function quiet(jobs: readonly ReflectionJob[]): boolean {
  if (!KEYLESS) {
    return jobs.length === 0;
  }
  return (
    jobs.every(
      (job) => job.jobType === INTEGRATE_JOB_TYPE && job.claimedAt === null && job.attempts === 0,
    ) && jobs.some((job) => (job.lastError ?? '').includes('has nowhere to run'))
  );
}

async function settled(): Promise<void> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (quiet(listReflectionJobs(migrationDb))) {
      // One more beat for the completion's own publication to land after the row goes.
      await pause(2_000);
      return;
    }
    await pause(500);
  }
  throw new Error('the reflection queue never drained');
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dir = mkdtempSync(join(tmpdir(), 'aion-cli-last-int-'));
  sqlitePath = join(dir, 'aion.sqlite');
  migrationDb = openSqliteHandle({ filePath: sqlitePath });
  await runGraphMigrations(harness.driver, migrationDb, { embedDimension: EMBED_DIMENSION });
  await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });

  const port = await freePort();
  started = await bootstrapService({
    AION_NEO4J_URI: harness.uri,
    AION_NEO4J_PASSWORD: harness.password,
    AION_OLLAMA_URL: 'http://127.0.0.1:11434',
    AION_SQLITE_PATH: sqlitePath,
    AION_LOG_FILE: join(dir, 'aion-mcp.jsonl'),
    AION_LOG_LEVEL: 'debug',
    AION_MCP_PORT: String(port),
    ...testGenerationEnv(),
  });
  await started.service.listen();
  const url = new URL(`http://127.0.0.1:${String(started.service.port)}${MCP_PATH}`);

  const client = new Client({ name: 'aion-cli-int-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  try {
    const ack = await client.callTool({
      name: 'reflection',
      arguments: { observations: [OBSERVATION] },
    });
    ReflectionOutputSchema.parse(ack.structuredContent);

    // Taken once the enrichment has settled. A recall's effects are fenced on the publication
    // position it read under, so one racing a running pipeline is served and records nothing,
    // and what this file reads back is the recorded pack.
    await settled();

    const recalled = await client.callTool({ name: 'recall', arguments: { query: QUERY } });
    mcpPack = recalled.structuredContent;

    const resolvedSessionId = transport.sessionId;
    if (resolvedSessionId === undefined) {
      throw new Error('client transport never received a session id');
    }
    sessionId = resolvedSessionId;
  } finally {
    await client.close();
  }
}, 300_000);

afterAll(async () => {
  await started.close();
  await stopNeo4jHarness(harness);
  migrationDb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('aion last against a pack served over the real MCP wire', () => {
  it('emits --json content identical to what the MCP client received', async () => {
    process.env.AION_SQLITE_PATH = sqlitePath;
    process.env.AION_LOG_FILE = join(dir, 'aion-cli.jsonl');
    const lines: string[] = [];
    try {
      const code = await runLast(['--session', sessionId, '--json'], (line) => lines.push(line));
      expect(code).toBe(0);
    } finally {
      delete process.env.AION_SQLITE_PATH;
      delete process.env.AION_LOG_FILE;
    }

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual(mcpPack);
  });

  it('renders the same session and item ids in text mode', async () => {
    process.env.AION_SQLITE_PATH = sqlitePath;
    process.env.AION_LOG_FILE = join(dir, 'aion-cli.jsonl');
    const lines: string[] = [];
    try {
      const code = await runLast(['--session', sessionId], (line) => lines.push(line));
      expect(code).toBe(0);
    } finally {
      delete process.env.AION_SQLITE_PATH;
      delete process.env.AION_LOG_FILE;
    }

    const text = lines.join('\n');
    expect(text).toContain(`session  ${sessionId}`);
    const pack = mcpPack as { episodes?: readonly { id: string }[] };
    for (const episode of pack.episodes ?? []) {
      expect(text).toContain(`id=${episode.id}`);
    }
  });
});
