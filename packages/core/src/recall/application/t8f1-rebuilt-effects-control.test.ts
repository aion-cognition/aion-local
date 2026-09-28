import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { runCheckedRecall, type CheckedRecallDeps } from './checked-recall.js';
import { CueCache } from './cues.js';
import type { ReadCoordinator } from './read-completion.js';
import type { RecallCompletion } from './recall-observers.js';
import * as stageReads from './stage-reads.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import {
  seedSource,
  commitIncidence,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import * as provenanceQueries from '../../infrastructure/graph/claim-provenance-queries.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type {
  CheckpointResult,
  PublicationCheckpoint,
} from '../../infrastructure/publication/types.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { readServedItems, recordServedItems } from '../../infrastructure/sqlite/served-items.js';
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
let recalled = 0;
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

function deps(): CheckedRecallDeps {
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
      recalled += 1;
    },
  };
}

function activate(at: Date = ACTIVATED_AT): void {
  activateCoverageContract(store.db, { activatedAt: at, fieldPolicyVersion: 1 });
}

function holdings(): readonly string[] {
  return [...readServedItems(store.db, IDENTITY).keys()];
}

function recall(payload: Record<string, unknown> = {}) {
  return runCheckedRecall(
    deps(),
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
  recalled = 0;
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

function installCandidates(owner: string, count = 1): void {
  seedSource(store.db, {
    sourceId: 'source',
    sessionId: owner,
    identity: 'review',
    content: { turns: [{ role: 'user', text: 'Atlas stores jobs in Valkey' }] },
    now: ACTIVATED_AT,
  });
  const items = Array.from({ length: count }, (_, n) =>
    item(`candidate-${n}`, {
      labels: ['Insight', 'Memory', 'AionNode'],
      content: 'Atlas stores jobs in Valkey',
      score: 0.9 - n * 0.01,
    }),
  );
  for (const candidate of items) {
    commitIncidence(store.db, {
      sourceId: 'source',
      nodeId: candidate.id,
      role: 'extraction',
      operationId: `extract-${candidate.id}`,
      at: ACTIVATED_AT,
    });
    for (const { role, direction } of OWNERSHIP_SCOPES) {
      establishScope(store.db, candidate.id, durableRoleScope(role, direction), ACTIVATED_AT);
    }
    establishScope(store.db, candidate.id, GRAPH_NODE_SCOPE, ACTIVATED_AT);
  }
  establishScope(store.db, 'source', 'sqlite:stated_derivation:out', ACTIVATED_AT);
  vi.spyOn(fusionModule, 'fuse').mockReturnValue({
    items,
    refused: [],
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
  vi.spyOn(stageReads, 'restatedClaimPairs').mockResolvedValue(
    count === 2 ? [{ left: 'candidate-0', right: 'candidate-1' }] : [],
  );
}

it('preserves a held candidate when the initial publication position is unavailable', async () => {
  activate();
  installCandidates('other-session');
  const first = await recall();
  expect(first.status).toBe('pack');
  if (first.status === 'pack') {
    expect([...emittedPackIds(first.pack)]).toEqual(['candidate-0']);
  }
  expect(holdings()).toContain('candidate-0');
  expect(recalled).toBeGreaterThan(0);
  expect(embedCalls).toBeGreaterThan(0);
  position = { status: 'unavailable', reason: 'pending_publication' };
  const second = await recall();
  expect(second.status).toBe('pack');
  if (second.status === 'pack') {
    expect([...emittedPackIds(second.pack)]).toContain('candidate-0');
  }
});

it('does not use uncheckpointed own-only evidence to subtract the candidate', async () => {
  activate();
  installCandidates(IDENTITY);
  const first = await recall();
  if (first.status === 'pack') {
    expect([...emittedPackIds(first.pack)]).toEqual([]);
  }
  position = { status: 'unavailable', reason: 'pending_publication' };
  const second = await recall();
  expect(second.status).toBe('pack');
  if (second.status === 'pack') {
    expect([...emittedPackIds(second.pack)]).toContain('candidate-0');
  }
});

it('does not use uncheckpointed provenance to fold two eligible candidates', async () => {
  activate();
  installCandidates('other-session', 2);
  position = { status: 'unavailable', reason: 'pending_publication' };
  const result = await recall();
  expect(result.status).toBe('pack');
  if (result.status === 'pack') {
    expect([...emittedPackIds(result.pack)].sort()).toEqual(['candidate-0', 'candidate-1']);
  }
});

it('reconstructs subtraction decisions when the final publication position is stale', async () => {
  activate();
  installCandidates('other-session');
  await recall();
  expect(holdings()).toContain('candidate-0');
  declineWith = 'publication_changed';
  const result = await recall();
  if (result.status === 'pack') {
    expect([...emittedPackIds(result.pack)]).toContain('candidate-0');
  }
});

it('marks an entirely uncheckpointed interpretation as partial without requiring a reset', async () => {
  activate();
  installCandidates('other-session');
  position = { status: 'unavailable', reason: 'pending_publication' };
  const result = await recall();
  expect(result.status).toBe('pack');
  if (result.status === 'pack') {
    expect(result.pack.metadata.history_coverage?.status).toBe('partial');
  }
});

it('does not label a store-unavailable checkpoint as a pending publication', async () => {
  activate();
  installCandidates('other-session');
  position = { status: 'unavailable', reason: 'store_unavailable' };
  const result = await recall();
  expect(result.status).toBe('pack');
  if (result.status === 'pack') {
    expect(result.pack.metadata.history_coverage?.gaps).toContainEqual(
      expect.objectContaining({ reason: 'store_unavailable' }),
    );
    expect(
      result.pack.metadata.history_coverage?.gaps.some(
        (gap) => gap.reason === 'pending_publication',
      ),
    ).toBe(false);
  }
});

it('reports the rebuilt emitted set to both observers while preserving stored holdings', async () => {
  activate();
  installCandidates('other-session');
  await recall();
  const previous = getLastPack(store.db, IDENTITY);
  const held = readServedItems(store.db, IDENTITY);
  const beforeEmbeds = embedCalls;
  declineWith = 'publication_changed';
  const result = await recall();
  expect(result.status).toBe('pack');
  if (result.status !== 'pack') {
    throw new Error('expected qualified answer');
  }
  expect([...emittedPackIds(result.pack)]).toEqual(['candidate-0']);
  expect(traces.at(-1)?.emitted.ids).toEqual(['candidate-0']);
  expect(traces.at(-1)?.withheldRepeat.ids).toEqual([]);
  expect([...completions.at(-1)!.emitted]).toEqual(['candidate-0']);
  expect(completions.at(-1)?.pack).toEqual(result.pack);
  expect(getLastPack(store.db, IDENTITY)).toEqual(previous);
  expect(readServedItems(store.db, IDENTITY)).toEqual(held);
  expect(embedCalls - beforeEmbeds).toBe(1);
});

it('preserves a requested reset during outage and suppresses the unchanged item on recovery', async () => {
  activate();
  installCandidates('other-session');
  await recall();
  const held = readServedItems(store.db, IDENTITY);
  position = { status: 'unavailable', reason: 'store_unavailable' };
  const partial = await recall({ reset_delivery_suppression: true });
  expect(readServedItems(store.db, IDENTITY)).toEqual(held);
  if (partial.status !== 'pack') {
    throw new Error('expected qualified answer');
  }
  expect([...emittedPackIds(partial.pack)]).toEqual(['candidate-0']);
  expect(partial.pack.metadata.history_coverage?.status).toBe('partial');
  expect(partial.pack.metadata.history_coverage?.gaps).toContainEqual(
    expect.objectContaining({ field: 'eligibility', reason: 'store_unavailable' }),
  );
  position = { status: 'ready', checkpoint: CHECKPOINT };
  const recovered = await recall();
  if (recovered.status !== 'pack') {
    throw new Error('expected recovered answer');
  }
  expect([...emittedPackIds(recovered.pack)]).toEqual([]);
});
