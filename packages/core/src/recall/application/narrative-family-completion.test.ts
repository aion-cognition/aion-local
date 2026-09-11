import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { runCheckedRecall, type CheckedRecallDeps } from './checked-recall.js';
import { CueCache } from './cues.js';
import type { ReadCoordinator } from './read-completion.js';
import type { RecallCompletion } from './recall-observers.js';
import * as stageReads from './stage-reads.js';
import * as representationAdapter from '../../evidence/application/narrative-representation.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import * as provenanceQueries from '../../infrastructure/graph/claim-provenance-queries.js';
import * as families from '../../infrastructure/graph/narrative-families.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type {
  CheckpointResult,
  PublicationCheckpoint,
} from '../../infrastructure/publication/types.js';
import { sealChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { acknowledgeFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { readServedItems, recordServedItems } from '../../infrastructure/sqlite/served-items.js';
import {
  acknowledgeFamilyAdvance,
  prepareFamilyAdvance,
} from '../../reflection/application/family-fence.js';
import { FakeGraph } from '../../reflection/test-support/fake-graph.fixture.js';
import { SessionManager } from '../../session/session-manager.js';
import * as fusionModule from '../domain/fusion.js';
import type { RecallTrace } from '../domain/recall-trace.js';
import { emittedPackIds } from '../domain/session-dedup.js';
import { item, report } from '../domain/test-support/pack.fixture.js';

/**
 * The covered entry point, end to end over a real store and a stubbed coordinator: what a
 * refused request costs, what a served one records, and what a contract that moves under the
 * read takes back. The real coordinator and a real graph are `checked-recall.int.test.ts`.
 */

const MEMBER_ID = 'member-1';
const WORKSPACE_ID = 'workspace-global';
const IDENTITY = 'session-1';
const NOW = new Date('2026-09-08T12:00:00.000Z');
const ACTIVATED_AT = new Date('2026-09-08T02:00:00.000Z');

const CHECKPOINT: PublicationCheckpoint = {
  substrateId: 'substrate-1',
  protocolVersion: 1,
  sequence: '4',
  operationId: null,
  intentDigest: null,
  resultDigest: null,
};

/** Answers the read shapes it models and nothing for the rest, so an empty substrate answers. */
class EmptySubstrateGraph extends FakeGraph {
  override async executeQuery(cypher: string, parameters: Record<string, unknown> = {}) {
    try {
      return await super.executeQuery(cypher, parameters);
    } catch {
      return {
        records: [],
        summary: {
          counters: {
            updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 }),
          },
        },
      };
    }
  }
}

let dir: string;
let store: SqliteStore;
let logger: Logger;
let graph: EmptySubstrateGraph;
let embedCalls = 0;
let completions: RecallCompletion[] = [];
let traces: RecallTrace[] = [];
/** What the stubbed coordinator answers, and what it does the moment a read reaches it. */
let position: CheckpointResult;
let declineWith: string | undefined;
let atBoundary: (() => void) | undefined;

const provider = {
  embed: (texts: readonly string[]) => {
    embedCalls += 1;
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  },
  generate: () => {
    return Promise.reject(new Error('a covered recall test never spends a generation'));
  },
} as unknown as Provider;

const coordinator: ReadCoordinator = {
  checkpoint: () => Promise.resolve(position),
  completeRead(_checkpoint, _validate, complete) {
    atBoundary?.();
    if (declineWith !== undefined) {
      return Promise.resolve({ status: 'retry', reason: declineWith });
    }
    return Promise.resolve({
      status: 'completed',
      value: store.db.transaction(() => complete(store.db))(),
    });
  },
};

function recallDeps(): CheckedRecallDeps {
  return {
    driver: graph.driver,
    db: store.db,
    sessions: new SessionManager(graph.driver, { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID }),
    provider,
    config: DEFAULTS,
    cueCache: new CueCache(),
    logger,
    resolver: new EvidenceResolver({ driver: graph.driver, db: store.db, logger }),
    coordinator,
    onTrace: (trace) => {
      traces.push(trace);
    },
    onRecalled: (completion) => {
      completions.push(completion);
    },
  };
}

function activate(at: Date = ACTIVATED_AT): void {
  activateCoverageContract(store.db, { activatedAt: at, fieldPolicyVersion: 1 });
}

function recall(payload: Record<string, unknown> = {}) {
  return runCheckedRecall(
    recallDeps(),
    { query: 'why webhooks', ...payload },
    {
      identity: IDENTITY,
      now: NOW,
    },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-checked-recall-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
  graph = new EmptySubstrateGraph();
  graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode'], { name: 'Ryan Huber' });
  graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode'], { name: 'global' });
  prepareCoverageContract(store.db, 1);
  recordServedItems(store.db, IDENTITY, [{ itemId: 'held', fingerprint: 'f' }], NOW.toISOString());
  embedCalls = 0;
  completions = [];
  traces = [];
  position = { status: 'ready', checkpoint: CHECKPOINT };
  declineWith = undefined;
  atBoundary = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function prepare(operationId: string): void {
  preparePublicationIntent(store.db, {
    operationId,
    kind: 'family_cutover',
    payloadDigest: operationId,
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: ACTIVATED_AT,
  });
}
function acknowledge(operationId: string): void {
  acknowledgePublicationIntent(store.db, {
    operationId,
    resultDigest: operationId,
    resultJson: '{}',
    observedAckAt: ACTIVATED_AT,
  });
}
function family(familyName: 'chunk' | 'legacy_session_overview', version: number): void {
  const operationId = `family-${String(version)}`;
  prepare(operationId);
  prepareFamilyAdvance(store.db, 'narrated-session', operationId, ACTIVATED_AT);
  store.db
    .transaction(() => {
      acknowledgeFamilySelection(store.db, {
        sessionId: 'narrated-session',
        family: familyName,
        operationId,
        expectedVersion: version,
      });
      acknowledgeFamilyAdvance(
        store.db,
        'narrated-session',
        operationId,
        ACTIVATED_AT.toISOString(),
      );
      acknowledge(operationId);
    })
    .immediate();
}

function installNarratives(): string {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: 'narrated-session',
    identity: 'other',
    content: { observations: ['an attributable source'] },
    now: ACTIVATED_AT,
  });
  const { chunkId } = sealChunk(store.db, {
    sessionId: 'narrated-session',
    sourceIds: ['source'],
    sealedAt: ACTIVATED_AT,
  });
  const allocation = allocateNarrativeRevision(
    store.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    ACTIVATED_AT,
  );
  prepare('chunk-publication');
  publishNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, {
    familyKey: chunkId,
    revisionNo: allocation.revisionNo,
    operationId: 'chunk-publication',
    evidenceRevisionJson: '{"dependencies":[]}',
    knownFrom: ACTIVATED_AT.toISOString(),
    observedAckAt: ACTIVATED_AT.toISOString(),
    publishedAt: ACTIVATED_AT,
  });
  acknowledge('chunk-publication');
  family('legacy_session_overview', 0);
  const items = [
    item('legacy', { labels: ['Narrative', 'Memory'], content: 'the whole session narrative' }),
    item(allocation.nodeId, { labels: ['Narrative', 'Memory'], content: 'the bounded chunk' }),
    item('fact', { labels: ['Decision', 'Memory'], content: 'a retained decision' }),
  ];
  vi.spyOn(fusionModule, 'fuse').mockReturnValue({
    items,
    admission: report(items),
    methodStats: {},
  });
  vi.spyOn(provenanceQueries, 'fetchClaimProvenance').mockResolvedValue(
    new Map(
      items.map((candidate) => [
        candidate.id,
        { roots: ['source'], lineage: ['source'], complete: true },
      ]),
    ),
  );
  vi.spyOn(families, 'findNarrativeFamilyIdentities').mockResolvedValue([
    { nodeId: 'legacy', family: 'legacy_session_overview', sessionId: 'narrated-session' },
    { nodeId: allocation.nodeId, family: 'chunk', sessionId: 'narrated-session' },
  ]);
  vi.spyOn(stageReads, 'restatedClaimPairs').mockResolvedValue([]);
  return allocation.nodeId;
}

it('revalidates only policy after a final-boundary family change and emits one family', async () => {
  activate();
  const chunkId = installNarratives();
  const prior = await recall();
  expect(prior.status).toBe('pack');
  if (prior.status !== 'pack') {
    throw new Error('expected first pack');
  }
  expect([...emittedPackIds(prior.pack)].sort()).toEqual(['fact', 'legacy']);
  const held = readServedItems(store.db, IDENTITY);
  const saved = getLastPack(store.db, IDENTITY);
  let embeddingsAtBoundary = -1;
  atBoundary = () => {
    family('chunk', 1);
    embeddingsAtBoundary = embedCalls;
  };
  declineWith = 'publication_changed';
  const revalidation = vi.spyOn(representationAdapter, 'revalidateNarrativeRepresentations');
  const result = await recall();
  expect(result.status).toBe('pack');
  if (result.status !== 'pack') {
    throw new Error('expected degraded pack');
  }
  expect([...emittedPackIds(result.pack)].sort()).toEqual([chunkId, 'fact'].sort());
  expect(revalidation).toHaveBeenCalledTimes(1);
  expect(embedCalls).toBe(embeddingsAtBoundary);
  expect(readServedItems(store.db, IDENTITY)).toEqual(held);
  expect(getLastPack(store.db, IDENTITY)).toEqual(saved);
  expect([...completions.at(-1)!.emitted].sort()).toEqual([chunkId, 'fact'].sort());
});

it('withholds narratives with an unreadable final family policy while retaining other candidates', async () => {
  activate();
  installNarratives();
  atBoundary = () => {
    store.db.exec('ALTER TABLE family_selection_log RENAME TO unavailable_family_selection');
  };
  declineWith = 'publication_changed';
  try {
    const result = await recall();
    expect(result.status).toBe('pack');
    if (result.status !== 'pack') {
      throw new Error('expected qualified pack');
    }
    expect([...emittedPackIds(result.pack)]).toEqual(['fact']);
    expect(result.pack.metadata.history_coverage?.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'representation_preference',
          reason: 'store_unavailable',
        }),
      ]),
    );
  } finally {
    store.db.exec('ALTER TABLE unavailable_family_selection RENAME TO family_selection_log');
  }
});
