import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  backboneBirthPublication,
  publishBackboneBirth,
  type BackboneBirthOutcome,
} from './backbone-evidence.js';
import { scriptedEntityJudge } from './entity-merge-judge.fixture.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { handleReflection } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { ReflectionOrchestrator, type ReflectionRun } from './orchestrator.js';
import { EntityExtractionStage } from './stages/entities.js';
import { EntityDedupStage } from './stages/entity-dedup.js';
import { CoveredJudgmentEvidence } from '../../evidence/application/covered-judgment.js';
import { NODE_SUPPORT_ROLE_SCOPES } from '../../evidence/application/node-support.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  bootstrapBackbone,
  type BootstrapBackboneResult,
} from '../../infrastructure/graph/backbone.js';
import { runRead } from '../../infrastructure/graph/connection.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  clearGraphNodes,
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { activateCoverageOnStart } from '../../infrastructure/publication/coverage-activation.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * The backbone on a substrate nobody has used yet, through the paths that make one: `aion init`
 * bootstraps it, the service starts, the service restarts, and an episode names the substrate.
 *
 * Before the birth census the Substrate carried only the mention and participation counters its
 * first episode moved, both uncounted, and no node-state counter at all, so every pair naming it
 * was withheld as `required_scope_missing` and the job that owed the pair never completed. The
 * judge here is scripted: the subject is whether the pair reaches it, not what it answers.
 */

const DIMENSION = DEFAULTS.models.embedDimension;
const MEMBER_NAME = 'Ryan Huber';
const DUPLICATE = { name: 'Aion memory', type: 'tool', context: 'the service that answers recall' };
const SUBSTRATE = { name: 'Aion', type: 'project', context: 'the memory substrate itself' };

/** Two records naming only the duplicate, so on mentions alone it is the stronger identity. */
const EARLIER = [
  'The Aion memory service answered recall in under a second this morning.',
  'The Aion memory service restarted cleanly after the upgrade.',
];
const NAMING_BOTH = 'Aion keeps the memory, and the Aion memory service answers recall.';

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let backbone: BootstrapBackboneResult;
let firstStart: BackboneBirthOutcome;
let restart: BackboneBirthOutcome;
let publications: PublicationCoordinator;
let countedBeforeStart: boolean;
let mentionsBeforePair: { readonly duplicate: number; readonly substrate: number };

function backboneIds(): readonly string[] {
  return [backbone.member.id, backbone.workspace.id, backbone.substrate?.id ?? ''];
}

/** Every counter a judgment or a support reading asks of one node, with its census status. */
function censusOf(nodeId: string): Record<string, string | undefined> {
  const rows = db
    .prepare(
      'SELECT relation_class, census_status FROM evidence_scope_versions WHERE endpoint_id = ?',
    )
    .all(nodeId) as { relation_class: string; census_status: string }[];
  const held = new Map(rows.map((row) => [row.relation_class, row.census_status]));
  return Object.fromEntries(
    [...NODE_SUPPORT_ROLE_SCOPES, GRAPH_NODE_SCOPE].map((scope) => [scope, held.get(scope)]),
  );
}

function allEstablished(): Record<string, string> {
  return Object.fromEntries(
    [...NODE_SUPPORT_ROLE_SCOPES, GRAPH_NODE_SCOPE].map((scope) => [scope, 'established']),
  );
}

function publishedRevisions(nodeId: string): readonly unknown[] {
  return db
    .prepare(
      `SELECT relation_class, published_revision FROM evidence_scope_versions
       WHERE endpoint_id = ? ORDER BY relation_class`,
    )
    .all(nodeId);
}

/** What the service does at start, in its order: backbone, coordinator, coverage, birth census. */
async function startService(): Promise<BackboneBirthOutcome> {
  await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  publications = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
  });
  await publications.initialize();
  await activateCoverageOnStart(publications, db);
  return publishBackboneBirth({ driver: harness.driver, db, publications });
}

/** An empty graph and a new store beside it, which is what `aion init` finds on a reset. */
async function openFreshSubstrate(file: string): Promise<void> {
  await clearGraphNodes(harness.driver);
  db = openSqliteHandle({ filePath: join(dataDir, file) });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
}

function axisVector(axis: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[axis] = 1;
  return vector;
}

async function reflectOn(
  identity: string,
  text: string,
  entities: readonly (typeof SUBSTRATE)[],
): Promise<{ readonly run: ReflectionRun; readonly judged: readonly StructuredRequest[] }> {
  const judge = scriptedEntityJudge();
  const provider: Provider = {
    // One axis for every text naming the substrate, so the two names nominate each other.
    embed: async (texts) => texts.map((input) => axisVector(/aion/i.test(input) ? 0 : 1)),
    generate: async (request) =>
      request.surface === 'entities' ? { entities } : judge.generate(request),
  };
  const stored = await handleReflection(
    {
      driver: harness.driver,
      db,
      sessions: new SessionManager(harness.driver, {
        memberId: backbone.member.id,
        workspaceId: backbone.workspace.id,
      }),
      publications,
      logger,
      entropyThreshold: DEFAULTS.redaction.entropyThreshold,
      lanes: new LaneAssigner(DEFAULTS.lanes),
      workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    },
    { turns: [{ role: 'user', text }] },
    { identity },
  );
  const evidence = new CoveredJudgmentEvidence({
    db,
    resolver: new EvidenceResolver({ driver: harness.driver, db, logger, publications }),
  });
  const run = await new ReflectionOrchestrator(
    { driver: harness.driver, db, provider, logger, evidence, publications },
    [new EntityExtractionStage(), new EntityDedupStage({ mode: 'unanimous' })],
  ).run(stored.episode_id);
  return { run, judged: judge.calls };
}

function withheldReasons(run: ReflectionRun): readonly string[] {
  return (
    run.summary.stages
      .find((stage) => stage.name === 'entity-dedup')
      ?.withheldWork?.map((work) => work.reason) ?? []
  );
}

async function mentionsOf(nameNorm: string): Promise<number> {
  const rows = await runRead(
    harness.driver,
    'MATCH (e:Episode)-[:MENTIONS]->(:Entity { name_norm: $nameNorm }) RETURN count(DISTINCT e) AS n',
    { nameNorm },
    (row) => row.n as number,
  );
  return rows[0] ?? 0;
}

async function labelsOf(id: string): Promise<readonly string[]> {
  const rows = await runRead(
    harness.driver,
    'MATCH (n:AionNode { id: $id }) RETURN labels(n) AS labels',
    { id },
    (row) => row.labels as string[],
  );
  return rows[0] ?? [];
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-backbone-evidence-int-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await openFreshSubstrate('aion.sqlite');

  // `aion init`: migrations, then the backbone, with no coordinator standing yet.
  backbone = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
  countedBeforeStart = backboneIds().some((id) => censusOf(id)[GRAPH_NODE_SCOPE] !== undefined);
  firstStart = await startService();
  restart = await startService();
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the backbone on a fresh substrate', () => {
  it('is counted at the first service start, and a restart finds nothing owed', () => {
    expect(backbone.substrate?.created).toBe(true);
    expect(countedBeforeStart).toBe(false);
    expect(firstStart).toMatchObject({ status: 'published', established: 3 });
    expect(restart).toEqual({ status: 'nothing_owed' });
    for (const id of backboneIds()) {
      expect(censusOf(id)).toEqual(allEstablished());
      // Graph-authority: a census with no mirror is a scope no reader can take a version from.
      expect(
        readScopeMirror(db, { endpointId: id, relationClass: GRAPH_NODE_SCOPE }),
      ).toBeDefined();
    }
  });

  it('puts a pair naming the substrate before the judge, and the job completes', async () => {
    const substrateId = backbone.substrate?.id ?? '';
    for (const [index, text] of EARLIER.entries()) {
      const earlier = await reflectOn(`backbone-evidence-${String(index)}`, text, [DUPLICATE]);
      expect(earlier.run.applied).toBe(true);
      expect(earlier.judged).toEqual([]);
    }
    mentionsBeforePair = {
      duplicate: await mentionsOf('aion memory'),
      substrate: await mentionsOf('aion'),
    };
    const before = publishedRevisions(substrateId);

    const { run, judged } = await reflectOn('backbone-evidence', NAMING_BOTH, [
      SUBSTRATE,
      DUPLICATE,
    ]);

    expect(withheldReasons(run)).toEqual([]);
    expect(run.applied).toBe(true);
    // Both passes asked, about the substrate and the name that duplicates it.
    expect(judged).toHaveLength(2);
    for (const request of judged) {
      const prompt = request.messages.map((message) => message.content).join('\n');
      expect(prompt).toMatch(/^Entity [AB]: Aion$/m);
      expect(prompt).toMatch(/^Entity [AB]: Aion memory$/m);
    }
    // The mention moved the counters and kept the census the birth established.
    expect(censusOf(substrateId)).toEqual(allEstablished());
    expect(publishedRevisions(substrateId)).not.toEqual(before);
  }, 180_000);

  it('absorbs the duplicate into the structural identity and keeps the backbone whole', async () => {
    const substrateId = backbone.substrate?.id ?? '';
    // More episodes named the duplicate than the substrate, so the mention rule alone would have
    // kept the duplicate. The structural flag is what made the substrate the canonical.
    expect(mentionsBeforePair).toEqual({ duplicate: 2, substrate: 0 });
    const [state] = await runRead(
      harness.driver,
      [
        'MATCH (s:Substrate { id: $substrateId })',
        'OPTIONAL MATCH (s)-[:SUPERSEDES]->(absorbed:Entity)',
        'OPTIONAL MATCH (s)-[w:WITHIN_WORKSPACE]->(ws:Workspace { id: $workspaceId })',
        'RETURN s.valid_until IS NULL AS current, s.is_structural AS structural, s.name AS name,',
        '       s.type AS type, collect(DISTINCT absorbed.name) AS absorbed,',
        '       collect(DISTINCT absorbed.valid_until IS NOT NULL) AS closed,',
        '       count(DISTINCT w) AS workspaceEdges',
      ].join('\n'),
      { substrateId, workspaceId: backbone.workspace.id },
      (row) => ({
        current: row.current,
        structural: row.structural,
        name: row.name,
        type: row.type,
        absorbed: row.absorbed,
        closed: row.closed,
        workspaceEdges: row.workspaceEdges,
      }),
    );

    expect(state).toEqual({
      current: true,
      structural: true,
      name: 'Aion',
      type: 'substrate',
      absorbed: ['Aion memory'],
      closed: [true],
      workspaceEdges: 1,
    });
    // The merge wrote the canonical's aliases through a MERGE on `Entity`; the backbone stays
    // out of `Memory` all the same.
    for (const id of backboneIds()) {
      expect(await labelsOf(id)).not.toContain('Memory');
    }
    expect(censusOf(substrateId)).toEqual(allEstablished());
  });
});

describe('a backbone an older build minted', () => {
  it('keeps the gap it has, and a publication naming an unmarked id is refused', async () => {
    db.close();
    await openFreshSubstrate('legacy.sqlite');
    const legacy = await bootstrapBackbone(harness.driver, { memberName: MEMBER_NAME });
    // What every backbone written before the creation mark looks like: the same node, unmarked.
    await harness.driver.executeQuery(
      'MATCH (n:Member|Workspace|Substrate) REMOVE n.extraction_method',
    );

    expect(await startService()).toEqual({ status: 'nothing_owed' });
    const substrateId = legacy.substrate?.id ?? '';
    expect(censusOf(substrateId)[GRAPH_NODE_SCOPE]).toBeUndefined();

    const refused = await publications.publish({
      kind: backboneBirthPublication.kind,
      operationId: 'legacy-backbone-birth',
      payload: { observedAt: new Date().toISOString(), nodeIds: [substrateId] },
    });
    expect(refused).toMatchObject({ status: 'rejected', reason: 'not_a_backbone_birth' });
    expect(censusOf(substrateId)[GRAPH_NODE_SCOPE]).toBeUndefined();
  }, 180_000);
});
