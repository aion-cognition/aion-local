import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config/defaults.js';
import { bootstrapBackbone } from '../graph/backbone.js';
import { runRead } from '../graph/connection.js';
import { runGraphMigrations } from '../graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../graph/test-support/neo4j-harness.fixture.js';
import type { Row } from '../graph/values.js';
import { openLogger } from '../logging/logger.js';
import { OllamaProvider } from '../providers/ollama-provider.js';
import { SessionManager } from '../session/session-manager.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { listReflectionJobs } from '../sqlite/reflection-queue.js';
import { ReflectionDispatch, type ReflectionJobSignal } from './dispatch.js';
import { handleReflection, INTEGRATE_JOB_TYPE, type ReflectionIntakeDeps } from './intake.js';

const EMBED_DIMENSION = DEFAULTS.models.embedDimension;
const SESSION_IDENTITY = 'mcp-transport-session-1';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const GITHUB_TOKEN = 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

const MIXED_PAYLOAD = {
  turns: [
    {
      role: 'user',
      text: `deploy the ingestion service, the runner key is ${AWS_KEY}`,
      occurred_at: '2026-03-01T10:00:00Z',
    },
    { role: 'assistant', text: 'running the deploy now', occurred_at: '2026-03-01T10:00:05Z' },
  ],
  tool_executions: [
    {
      tool: 'bash',
      input: 'npm run deploy',
      status: 'error',
      output: { stderr: `remote auth failed for ${GITHUB_TOKEN}` },
      duration_ms: 8200,
      occurred_at: '2026-03-01T10:00:02Z',
    },
  ],
  observations: ['We keyed the sync on id_slug because the external ids churn'],
  summary: 'failed deploy of the ingestion service',
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let deps: ReflectionIntakeDeps;
let signals: ReflectionJobSignal[];
let backboneIds: { memberId: string; workspaceId: string };
let episodeId: string;

async function readOne<T>(cypher: string, parameters: Record<string, unknown>, map: (row: Row) => T): Promise<T | undefined> {
  const rows = await runRead(harness.driver, cypher, parameters, map);
  return rows[0];
}

async function nodeProperties(id: string): Promise<Record<string, unknown>> {
  const props = await readOne(
    'MATCH (n:AionNode { id: $id }) RETURN properties(n) AS props',
    { id },
    (row) => row.props as Record<string, unknown>,
  );
  return props ?? {};
}

async function nodeLabels(id: string): Promise<string[]> {
  const labels = await readOne(
    'MATCH (n:AionNode { id: $id }) RETURN labels(n) AS labels',
    { id },
    (row) => row.labels as string[],
  );
  return [...(labels ?? [])].sort();
}

async function countAll(cypher: string): Promise<number> {
  return (await readOne(cypher, {}, (row) => row.c as number)) ?? 0;
}

async function turnsOfEpisode(): Promise<Array<Record<string, unknown>>> {
  return runRead(
    harness.driver,
    [
      'MATCH (t:Turn)-[:PARTICIPATES_IN]->(e:Episode { id: $episodeId })',
      'RETURN properties(t) AS props ORDER BY t.sequence',
    ].join('\n'),
    { episodeId },
    (row) => row.props as Record<string, unknown>,
  );
}

async function everyStoredProperty(): Promise<string> {
  const rows = await runRead(harness.driver, 'MATCH (n) RETURN properties(n) AS props', {}, (row) => row.props);
  return JSON.stringify(rows);
}

function ledgerRowCount(): number {
  return (db.prepare('SELECT count(*) AS c FROM ops_ledger').get() as { c: number }).c;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-reflection-intake-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  backboneIds = { memberId: backbone.member.id, workspaceId: backbone.workspace.id };

  signals = [];
  const dispatch = new ReflectionDispatch();
  dispatch.subscribe((signal) => {
    signals.push(signal);
  });

  deps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, backboneIds),
    provider: new OllamaProvider({
      baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      embedModel: DEFAULTS.models.embed,
    }),
    dispatch,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
  };

  const result = await handleReflection(deps, MIXED_PAYLOAD, { identity: SESSION_IDENTITY });
  expect(result.queued).toBe(true);
  episodeId = result.episode_id;
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reflection intake against a live graph and live Ollama', () => {
  it('stores the episode with its labels, content, provenance, and a full bitemporal stamp', async () => {
    const props = await nodeProperties(episodeId);

    expect(await nodeLabels(episodeId)).toEqual(['AionNode', 'Episode', 'Memory']);
    expect(props.summary).toBe(MIXED_PAYLOAD.summary);
    expect(props.session_id).toBe(SESSION_IDENTITY);
    expect(props.extraction_method).toBe('reflection_intake');
    expect(props.turn_count).toBe(2);
    expect(props.tool_execution_count).toBe(1);
    expect(props.observation_count).toBe(1);
    expect(props.content_hash).toEqual(expect.any(String));

    expect(props.occurred_at).toBeInstanceOf(Date);
    expect((props.occurred_at as Date).toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(props.valid_from).toBeInstanceOf(Date);
    expect(props.tx_from).toBeInstanceOf(Date);
    expect(props.valid_until).toBeUndefined();
    expect(props.tx_until).toBeUndefined();
  });

  it('folds tool executions and observations into the episode body', async () => {
    const text = (await nodeProperties(episodeId)).text as string;

    expect(text).toContain('tool bash [error, 8200ms]');
    expect(text).toContain('observation: We keyed the sync on id_slug');
    expect(text).toContain('user: deploy the ingestion service');
  });

  it('stores every turn in order, linked to the episode and chained to its predecessor', async () => {
    const turns = await turnsOfEpisode();

    expect(turns.map((turn) => turn.sequence)).toEqual([0, 1]);
    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(turns.every((turn) => turn.source_episode_id === episodeId)).toBe(true);
    expect(turns.every((turn) => turn.occurred_at instanceof Date)).toBe(true);
    expect(turns.every((turn) => turn.valid_until === undefined)).toBe(true);

    const chained = await countAll(
      'MATCH (:Turn { sequence: 1 })-[r:FOLLOWS]->(:Turn { sequence: 0 }) RETURN count(r) AS c',
    );
    expect(chained).toBe(1);
  });

  it('links the episode into the session and the session into the backbone', async () => {
    const sessionOfEpisode = await readOne(
      'MATCH (:Episode { id: $episodeId })-[:PARTICIPATES_IN]->(s:Session) RETURN s.id AS id',
      { episodeId },
      (row) => row.id as string,
    );
    expect(sessionOfEpisode).toBe(SESSION_IDENTITY);

    const member = await readOne(
      'MATCH (:Session { id: $sessionId })-[:INITIATED_BY]->(m:Member) RETURN m.id AS id',
      { sessionId: SESSION_IDENTITY },
      (row) => row.id as string,
    );
    const workspace = await readOne(
      'MATCH (:Session { id: $sessionId })-[:WITHIN_WORKSPACE]->(w:Workspace) RETURN w.id AS id',
      { sessionId: SESSION_IDENTITY },
      (row) => row.id as string,
    );

    expect(member).toBe(backboneIds.memberId);
    expect(workspace).toBe(backboneIds.workspaceId);
  });

  it('embeds the episode and every turn at intake, at the configured dimension', async () => {
    const episodeVector = (await nodeProperties(episodeId)).content_vec as number[];
    const turns = await turnsOfEpisode();

    expect(episodeVector).toHaveLength(EMBED_DIMENSION);
    expect(episodeVector.every((value) => Number.isFinite(value))).toBe(true);
    for (const turn of turns) {
      expect(turn.content_vec as number[]).toHaveLength(EMBED_DIMENSION);
    }
  });

  it('enqueues one integrate job carrying the episode id, and signals the dispatcher once', () => {
    const jobs = listReflectionJobs(db);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.jobType).toBe(INTEGRATE_JOB_TYPE);
    expect(jobs[0]?.payload).toEqual({ episode_id: episodeId });
    expect(jobs[0]?.claimedBy).toBeNull();

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ episodeId, sessionId: SESSION_IDENTITY, jobId: jobs[0]?.id });
  });

  it('leaves the ops ledger untouched: the pipeline owns it, not intake', () => {
    expect(ledgerRowCount()).toBe(0);
  });

  it('never stores the raw secret in any node property, only its fingerprint', async () => {
    const stored = await everyStoredProperty();

    expect(stored).not.toContain(AWS_KEY);
    expect(stored).not.toContain(GITHUB_TOKEN);
    expect(stored).toContain('⟨secret:aws-access-key:');
    expect(stored).toContain('⟨secret:github-token:');
  });

  it('returns the original episode id for a repeat push, writing no new nodes, edges, or jobs', async () => {
    const nodesBefore = await countAll('MATCH (n) RETURN count(n) AS c');
    const edgesBefore = await countAll('MATCH ()-[r]->() RETURN count(r) AS c');

    const repeat = await handleReflection(deps, MIXED_PAYLOAD, { identity: SESSION_IDENTITY });

    expect(repeat).toEqual({ episode_id: episodeId, queued: true });
    expect(await countAll('MATCH (n) RETURN count(n) AS c')).toBe(nodesBefore);
    expect(await countAll('MATCH ()-[r]->() RETURN count(r) AS c')).toBe(edgesBefore);
    expect(listReflectionJobs(db)).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(ledgerRowCount()).toBe(0);
  });

  it('stores the same experience again under a second session identity', async () => {
    const other = await handleReflection(deps, MIXED_PAYLOAD, { identity: 'mcp-transport-session-2' });

    expect(other.episode_id).not.toBe(episodeId);
    expect(listReflectionJobs(db)).toHaveLength(2);
    expect(signals).toHaveLength(2);

    const follows = await countAll(
      `MATCH (:Session { id: "mcp-transport-session-2" })-[r:FOLLOWS]->(:Session { id: "${SESSION_IDENTITY}" }) RETURN count(r) AS c`,
    );
    expect(follows).toBe(1);
  });
});
