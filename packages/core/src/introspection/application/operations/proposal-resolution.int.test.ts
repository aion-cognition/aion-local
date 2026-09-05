import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { proposalResolutionOperation, resolutionLedgerKey } from './proposal-resolution.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { fetchNodeEdges } from '../../../infrastructure/graph/node-provenance.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  getSupersessionProposal,
  recordSupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import {
  handleReflection,
  type ReflectionIntakeDeps,
} from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import { INTROSPECTOR_RESOLUTION_METHOD } from '../../../reflection/application/proposals.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * One row of the shape the filing pass leaves behind: an open proposal over two claims of one
 * session, with the pair, the subject family, and the session window all readable. The
 * operation reads them, both judge passes answer, and the row is terminal by the end of the
 * run whichever way they answer.
 *
 * The judges run remotely here, so the file skips without a key rather than measuring the local
 * model against a queue the shipped profile decides on Haiku.
 *
 * Written out rather than imported: this is the read the gate batteries make, and `core` does
 * not import from `mcp`, where that constant lives.
 */
const REMOTE_JUDGE_ABSENT =
  (process.env.AION_ANTHROPIC_API_KEY ?? '').trim() === '' ||
  process.env.TEST_AION_GENERATION === 'local';

const PRIOR_TEXT = 'The Zephyr ingest worker polls its queue every 45 seconds.';
const NEXT_TEXT = 'The Zephyr ingest worker polls its queue every 5 seconds now.';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let live: Provider;
let priorFactId: string;
let nextFactId: string;
let proposalId: string;

async function isCurrent(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] === undefined;
}

function contextFor(): OperationContext {
  return {
    driver: harness.driver,
    db,
    config: DEFAULTS,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    provider: live,
    health: healthFixture(),
    now: new Date(),
    signal: new AbortController().signal,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-resolution-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  live = testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  const intake: ReflectionIntakeDeps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider: live,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };

  // One identity for both, so the two observations share a session and the resolver's window
  // read has an arc to report rather than a single episode.
  const identity = 'mcp-proposal-resolution';
  const prior = await handleReflection(
    intake,
    { turns: [{ role: 'assistant', text: PRIOR_TEXT }], summary: 'the poll interval as it was' },
    { identity },
  );
  const next = await handleReflection(
    intake,
    { turns: [{ role: 'assistant', text: NEXT_TEXT }], summary: 'the poll interval was changed' },
    { identity },
  );

  const now = new Date();
  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name: 'Zephyr ingest worker',
        nameNorm: 'zephyr ingest worker',
        type: 'service',
        text: 'Zephyr ingest worker (service): the worker that drains the ingest queue.',
        sourceEpisodeId: next.episode_id,
        extractionMethod: 'test-seed',
        confidence: 1,
        occurredAt: now,
      },
    ],
    now,
  );
  for (const episodeId of [prior.episode_id, next.episode_id]) {
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [entity!.id],
      now,
      confidence: 1,
      provenance: ['test-seed'],
    });
  }

  const [priorVector, nextVector] = await live.embed([PRIOR_TEXT, NEXT_TEXT]);
  const priorNode = await writeCognitiveNode(harness.driver, {
    episodeId: prior.episode_id,
    label: 'Concept',
    text: PRIOR_TEXT,
    contentVector: priorVector,
    occurredAt: now,
    now,
  });
  const nextNode = await writeCognitiveNode(harness.driver, {
    episodeId: next.episode_id,
    label: 'Decision',
    text: NEXT_TEXT,
    contentVector: nextVector,
    occurredAt: now,
    now,
  });
  priorFactId = priorNode.node.id;
  nextFactId = nextNode.node.id;

  proposalId = recordSupersessionProposal(db, {
    oldId: priorFactId,
    newId: nextFactId,
    confidence: 0.9,
    rationale: 'the poll interval changed',
    episodeId: next.episode_id,
    createdAt: now.toISOString(),
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('proposal_resolution against a live graph', () => {
  it('leaves the row terminal, with the verdict and its grounds in the ledger', async () => {
    expect(getSupersessionProposal(db, proposalId)?.resolvedAt).toBeNull();

    const outcome = await proposalResolutionOperation().run(contextFor());

    expect(outcome.itemsProcessed).toBe(1);
    expect(outcome.itemsAffected).toBe(1);
    expect(getSupersessionProposal(db, proposalId)?.resolvedAt).toEqual(expect.any(String));

    const summary = getLedgerEntry(db, resolutionLedgerKey('supersession', proposalId))
      ?.summary as { verdict: string; grounds: string };
    expect(['applied', 'dismissed']).toContain(summary.verdict);
    expect(summary.grounds).toContain('first pass');
    expect(summary.grounds).toContain('second pass');
    // Which way the live pair went, since both are correct outcomes and only the record says
    // which one this run made. Printed under `--reporter=verbose`.
    console.log(`RESOLUTION ${summary.verdict}: ${summary.grounds}`);

    if (summary.verdict === 'dismissed') {
      // A dismissal writes nothing to the graph, so the claim the correction named still stands.
      expect(await isCurrent(priorFactId)).toBe(true);
      return;
    }

    expect(await isCurrent(priorFactId)).toBe(false);
    const lineage = (await fetchNodeEdges(harness.driver, priorFactId)).filter(
      (edge) => edge.type === 'SUPERSEDES',
    );
    expect(lineage).toHaveLength(1);
    expect(lineage[0]?.otherId).toBe(nextFactId);
    // Lineage names the resolver rather than a person or the writing pipeline, which is what
    // makes an autonomous close readable as one months later.
    expect(lineage[0]?.provenance).toContain(INTROSPECTOR_RESOLUTION_METHOD);

    // The reversal anyone has, over a close this operation made: same command, same result.
    const reopened = await unsupersedeNode(harness.driver, { id: priorFactId });
    expect(reopened.justReopened).toBe(true);
    expect(await isCurrent(priorFactId)).toBe(true);
  }, 180_000);

  it('converges: a second run finds nothing open to decide', async () => {
    const outcome = await proposalResolutionOperation().run(contextFor());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsProcessed).toBe(0);
    expect(outcome.itemsAffected).toBe(0);
  }, 60_000);
});
