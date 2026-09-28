import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assessCandidates,
  assessedServing,
  assessmentPool,
  assessmentReach,
  candidateBudget,
  buildAssessmentMessages,
  readSelection,
  RECALL_ASSESSMENT_SURFACE,
  type AssessmentPool,
} from './assessment.js';
import { runCheckedRecall, type CheckedRecallDeps } from './checked-recall.js';
import { CueCache } from './cues.js';
import type { ReadCoordinator } from './read-completion.js';
import type { RecallCompletion } from './recall-observers.js';
import { capsFor } from './recall-policy.js';
import type { ServingAssembly } from './serving-assembly.js';
import { servedReading } from './serving-effects.js';
import * as stageReads from './stage-reads.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import {
  commitIncidence,
  establishScope,
  seedSource,
} from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import * as provenanceQueries from '../../infrastructure/graph/claim-provenance-queries.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { GenerationUnavailableError } from '../../infrastructure/providers/errors.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';
import type { PublicationCheckpoint } from '../../infrastructure/publication/types.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readServedItems } from '../../infrastructure/sqlite/served-items.js';
import { FakeGraph } from '../../reflection/test-support/fake-graph.fixture.js';
import { SessionManager } from '../../session/session-manager.js';
import * as fusionModule from '../domain/fusion.js';
import type { FusedItem } from '../domain/fusion.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';
import { emittedPackIds } from '../domain/session-dedup.js';
import { CAPS, CUES, TIMINGS, item, report } from '../domain/test-support/pack.fixture.js';

const EMPTY_VIEW: ResolvedEvidenceView = {
  provenance: new Map(),
  relatedClaims: new Map(),
  ownership: new Map(),
  degraded: new Set(),
  issues: [],
};

const QUIET_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function pool(found: readonly FusedItem[], associated: readonly FusedItem[] = []): AssessmentPool {
  return assessmentPool({
    found,
    associated,
    reminders: [],
    serving: { served: new Map(), dedup: true },
    view: EMPTY_VIEW,
    caps: CAPS,
  });
}

function fakeProvider(generate: (req: StructuredRequest) => Promise<unknown>): {
  provider: Provider;
  requests: StructuredRequest[];
} {
  const requests: StructuredRequest[] = [];
  const provider = {
    embed: (texts: readonly string[]) => Promise.resolve(texts.map(() => [1, 0, 0])),
    generate: (req: StructuredRequest) => {
      requests.push(req);
      return generate(req);
    },
    route: { provider: 'openai', model: 'gpt-6-luna' },
  } as unknown as Provider;
  return { provider, requests };
}

describe('what the assessment is shown', () => {
  it('shows the admitted ranking, then what the floors refused, then the associations', () => {
    const shown = pool([item('a'), item('b'), item('refused')], [item('association')]);

    expect(shown.entries.map((entry) => [entry.item.id, entry.population])).toEqual([
      ['a', 'found'],
      ['b', 'found'],
      ['refused', 'found'],
      ['association', 'associated'],
    ]);
    expect(shown.omitted).toBe(0);
  });

  it('keeps the associations their own slots however many direct finds there are, and counts what it left out', () => {
    const found = Array.from({ length: 60 }, (_, n) => item(`f${String(n)}`));
    const shown = pool(found, [item('association')]);
    const budget = Object.values(CAPS).reduce((sum, cap) => sum + cap, 0);

    expect(shown.entries).toHaveLength(budget);
    expect(shown.entries.at(-1)?.item.id).toBe('association');
    expect(shown.omitted).toBe(60 + 1 - budget);
  });

  it('shows a memory reached twice once, where it was first found', () => {
    const shown = pool([item('a')], [item('a'), item('b')]);

    expect(shown.entries.map((entry) => entry.item.id)).toEqual(['a', 'b']);
  });

  it('carries the query, the context and each candidate standing and time, with no retrieval scores', () => {
    const messages = buildAssessmentMessages(
      {
        query: 'what did we decide about the queue',
        summary: 'reviewing Atlas',
        recentTurns: [{ role: 'user', text: 'the job runner keeps stalling' }],
      },
      pool(
        [
          item('d', {
            labels: ['Decision', 'Memory'],
            content: 'we moved jobs to Valkey',
            occurredAt: new Date('2026-09-01T10:00:00.000Z'),
            superseded: true,
          }),
        ],
        [item('e', { content: 'x'.repeat(2_000) })],
      ),
      EMPTY_VIEW,
    );
    const user = messages[1]?.content ?? '';

    expect(messages[0]?.role).toBe('system');
    expect(user).toContain('what did we decide about the queue');
    expect(user).toContain('reviewing Atlas');
    expect(user).toContain('user: the job runner keeps stalling');
    expect(user).toContain('1. we moved jobs to Valkey');
    expect(user).toContain('Decision');
    expect(user).toContain('occurred 2026-09-01T10:00:00.000Z');
    expect(user).toContain('successor not among these');
    expect(user).toContain('[... 1200 more characters]');
    expect(user).not.toContain('vector 0.80');
  });
});

describe('reading the answer', () => {
  const shown = pool([item('a'), item('b'), item('c')]);

  it('maps the numbers to the real candidates, in the order the model gave them', () => {
    expect(readSelection(shown, { selected: [3, '#1', 3] })).toEqual({
      kind: 'selected',
      ids: ['c', 'a'],
      unknown: 0,
    });
  });

  it('drops a number that names no candidate and counts it', () => {
    expect(readSelection(shown, { selected: [2, 9, 0], note: ' partly relevant ' })).toEqual({
      kind: 'selected',
      ids: ['b'],
      unknown: 2,
      note: 'partly relevant',
    });
  });

  it('honors a selection of nothing as an answer', () => {
    expect(readSelection(shown, { selected: [] })).toEqual({
      kind: 'selected',
      ids: [],
      unknown: 0,
    });
  });

  it('reads numbers that name no candidate at all as unusable, not as an empty choice', () => {
    expect(readSelection(shown, { selected: [7, 8] })).toEqual({
      kind: 'failed',
      reason: 'invalid_output',
    });
    expect(readSelection(shown, { chosen: [1] })).toEqual({
      kind: 'failed',
      reason: 'invalid_output',
    });
  });
});

describe('the one call', () => {
  const shown = pool([item('a'), item('b')]);
  const query = { query: 'why webhooks' };

  it('asks once, on its own surface, without reasoning, and returns the selection', async () => {
    const { provider, requests } = fakeProvider(() => Promise.resolve({ selected: [2] }));

    const outcome = await assessCandidates(
      { provider, budgetMs: 1_000, logger: QUIET_LOGGER },
      query,
      shown,
      EMPTY_VIEW,
    );

    expect(outcome).toEqual({ kind: 'selected', ids: ['b'], unknown: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ surface: RECALL_ASSESSMENT_SURFACE, think: false });
  });

  it('makes no call when retrieval found nothing to judge', async () => {
    const { provider, requests } = fakeProvider(() => Promise.resolve({ selected: [] }));

    await assessCandidates(
      { provider, budgetMs: 1_000, logger: QUIET_LOGGER },
      query,
      pool([]),
      EMPTY_VIEW,
    );

    expect(requests).toEqual([]);
  });

  it('names why a call produced no answer: unavailable, timed out, or failed', async () => {
    const deps = (generate: () => Promise<unknown>) => ({
      provider: fakeProvider(generate).provider,
      budgetMs: 20,
      logger: QUIET_LOGGER,
    });
    const hang = (): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        setTimeout(() => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, 50);
      });

    await expect(
      assessCandidates(
        deps(() => Promise.reject(new GenerationUnavailableError('recall_assessment'))),
        query,
        shown,
        EMPTY_VIEW,
      ),
    ).resolves.toMatchObject({ kind: 'failed', reason: 'unavailable' });
    await expect(assessCandidates(deps(hang), query, shown, EMPTY_VIEW)).resolves.toMatchObject({
      kind: 'failed',
      reason: 'timeout',
    });
    await expect(
      assessCandidates(
        deps(() => Promise.reject(new Error('500'))),
        query,
        shown,
        EMPTY_VIEW,
      ),
    ).resolves.toMatchObject({ kind: 'failed', reason: 'model_error' });
  });
});

describe('what gets served for an outcome', () => {
  const admitted = item('admitted', {
    admittedBy: { rule: 'vector_floor', score: 0.8, qualifying: ['vector 0.80'] },
  });
  const refused: FusedItem = {
    ...item('refused', { measured: 0 }),
    evidence: [{ method: 'vector', relevance: 0.21 }],
  };
  const association = item('association');
  const ranking: ServingAssembly = {
    ranked: [admitted],
    served: new Map(),
    dedup: true,
    restated: [],
    assembly: {
      items: [admitted],
      admission: report([admitted]),
      caps: CAPS,
      tokenBudget: 2_000,
      cues: CUES,
      timings: TIMINGS,
      restating: new Set(['admitted']),
      resonant: [association],
    },
  };
  const shown = pool([admitted, refused], [association]);
  const serve = (outcome: Parameters<typeof assessedServing>[0]['outcome']) =>
    assessedServing({
      outcome,
      pool: shown,
      ranking,
      candidates: new Map([
        [admitted.id, admitted],
        [association.id, association],
      ]),
      admitted: new Set([admitted.id, association.id]),
      route: { provider: 'openai', model: 'gpt-6-luna' },
    });

  it('serves exactly the selection, in its order, with an item the floor refused marked as the model choice', () => {
    const served = serve({ kind: 'selected', ids: ['association', 'refused'], unknown: 0 });

    expect(served.assembly.assembly.order).toEqual(['association', 'refused']);
    expect(served.assembly.assembly.items.map((entry) => entry.id)).toEqual(['refused']);
    expect(served.assembly.assembly.resonant?.map((entry) => entry.id)).toEqual(['association']);
    expect(served.assembly.assembly.items[0]?.admittedBy).toEqual({
      rule: 'assessment',
      score: 0,
      qualifying: ['vector 0.21'],
    });
    expect(served.assembly.assembly.restating?.size).toBe(0);
    expect(served.candidates.has('refused')).toBe(true);
    expect(served.report).toEqual({
      outcome: 'selected',
      provider: 'openai',
      model: 'gpt-6-luna',
      shown: 3,
      omitted: 0,
      selected: 2,
    });
  });

  it('serves the ranking and says so when the call failed', () => {
    const served = serve({ kind: 'failed', reason: 'timeout' });

    expect(served.assembly.assembly.items).toEqual([admitted]);
    expect(served.assembly.assembly.degraded).toEqual([{ stage: 'assessment', reason: 'timeout' }]);
    expect(served.report.outcome).toBe('fallback');
  });
});

describe('the floor refusals the assessment reaches', () => {
  const assess = { ...DEFAULTS, recall: { ...DEFAULTS.recall, mode: 'assess' as const } };

  it('leaves one the run holds another way to that way, and counts what it cannot reach', () => {
    const refused = Array.from({ length: 60 }, (_, n) => item(`r${String(n)}`));
    const held = new Map([['r0', item('r0')]]);

    const reach = assessmentReach(assess, refused, held);

    const budget = candidateBudget(capsFor(assess));
    expect(reach.items.map((entry) => entry.id)).not.toContain('r0');
    expect(reach.items).toHaveLength(budget);
    expect(reach.beyond).toBe(59 - budget);
    const cues = { ...DEFAULTS, recall: { ...DEFAULTS.recall, mode: 'cues' as const } };
    expect(assessmentReach(cues, refused, held)).toEqual({ items: [], beyond: 0 });
  });

  it('counts refusals past its reach as omitted from view', () => {
    const shown = assessmentPool({
      found: [item('a')],
      associated: [],
      reminders: [],
      serving: { served: new Map(), dedup: true },
      view: EMPTY_VIEW,
      caps: CAPS,
      unreached: 7,
    });

    expect(shown.omitted).toBe(7);
  });

  it('leaves gaps about refusals the pack does not serve out of the coverage reading', () => {
    const issue = (id: string) =>
      ({
        address: { kind: 'id', id },
        field: 'ownership',
        reason: 'unverified_scope',
        required: true,
      }) as const;
    const view: ResolvedEvidenceView = {
      ...EMPTY_VIEW,
      issues: [issue('admitted'), issue('chosen'), issue('passed-over')],
    };

    const read = servedReading(view, [item('chosen'), item('passed-over')], ['chosen']);

    expect(
      read.issues.map((entry) => (entry.address.kind === 'id' ? entry.address.id : '')),
    ).toEqual(['admitted', 'chosen']);
  });
});

/**
 * The default mode end to end through the covered entry point, over a real store and a stubbed
 * coordinator, with fusion's answer pinned so the candidates are known.
 */
describe('recall in the assess mode', () => {
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
  let completions: RecallCompletion[];
  let declineWith: string | undefined;

  const coordinator: ReadCoordinator = {
    checkpoint: () => Promise.resolve({ status: 'ready', checkpoint: CHECKPOINT }),
    completeRead(_checkpoint, _validate, complete) {
      if (declineWith !== undefined) {
        return Promise.resolve({ status: 'retry', reason: declineWith });
      }
      return Promise.resolve({
        status: 'completed',
        value: store.db.transaction(() => complete(store.db))(),
      });
    },
  };

  const admitted = ['top', 'second'].map((id, n) =>
    item(id, {
      labels: ['Insight', 'Memory', 'AionNode'],
      content: `admitted memory ${id}`,
      score: 0.9 - n * 0.01,
      admittedBy: { rule: 'vector_floor', score: 0.8, qualifying: ['vector 0.80'] },
    }),
  );
  const refused: FusedItem = {
    ...item('under-floor', {
      labels: ['Decision', 'Memory', 'AionNode'],
      content: 'we chose Valkey after the Redis licence change',
      score: 0.01,
      measured: 0,
    }),
    evidence: [{ method: 'vector', relevance: 0.22 }],
  };

  function deps(generate: (req: StructuredRequest) => Promise<unknown>): {
    deps: CheckedRecallDeps;
    requests: StructuredRequest[];
  } {
    const { provider, requests } = fakeProvider(generate);
    return {
      requests,
      deps: {
        driver: graph.driver,
        db: store.db,
        sessions: new SessionManager(graph.driver, {
          memberId: MEMBER_ID,
          workspaceId: WORKSPACE_ID,
        }),
        provider,
        config: DEFAULTS,
        cueCache: new CueCache(),
        logger,
        resolver: new EvidenceResolver({ driver: graph.driver, db: store.db, logger }),
        coordinator,
        onRecalled: (completion) => {
          completions.push(completion);
        },
      },
    };
  }

  async function recall(generate: (req: StructuredRequest) => Promise<unknown>) {
    const run = deps(generate);
    const outcome = await runCheckedRecall(
      run.deps,
      { query: 'why Valkey' },
      {
        identity: IDENTITY,
        now: NOW,
      },
    );
    if (outcome.status !== 'pack') {
      throw new Error('expected a pack');
    }
    return { pack: outcome.pack, effects: outcome.effects, requests: run.requests };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-assess-recall-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' });
    graph = new EmptySubstrateGraph();
    graph.seedNode(MEMBER_ID, ['Member', 'Entity', 'AionNode'], { name: 'Ryan Huber' });
    graph.seedNode(WORKSPACE_ID, ['Workspace', 'Entity', 'AionNode'], { name: 'global' });
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: ACTIVATED_AT, fieldPolicyVersion: 1 });
    completions = [];
    declineWith = undefined;

    seedSource(store.db, {
      sourceId: 'source',
      sessionId: 'another-session',
      identity: 'review',
      content: { turns: [{ role: 'user', text: 'Atlas stores jobs in Valkey' }] },
      now: ACTIVATED_AT,
    });
    const every = [...admitted, refused];
    for (const candidate of every) {
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
      items: admitted,
      refused: [refused],
      admission: report(admitted),
      methodStats: {},
    });
    vi.spyOn(provenanceQueries, 'fetchClaimProvenance').mockResolvedValue(
      new Map(
        every.map((candidate) => [
          candidate.id,
          { roots: ['source'], lineage: ['source'], complete: true },
        ]),
      ),
    );
    vi.spyOn(stageReads, 'restatedClaimPairs').mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('retrieves on the query alone and spends its one call on the assessment', async () => {
    const { pack, requests } = await recall(() => Promise.resolve({ selected: [1] }));

    expect(requests.map((request) => request.surface)).toEqual([RECALL_ASSESSMENT_SURFACE]);
    expect(pack.metadata.cues).toEqual([{ text: 'why Valkey', source: 'raw_query', weight: 3 }]);
    expect(pack.metadata.stage_timings_ms.assessment).toBeGreaterThanOrEqual(0);
  });

  it('serves an unexpected choice the floor refused, and only what was chosen', async () => {
    const { pack, effects } = await recall(() => Promise.resolve({ selected: [3] }));

    expect([...emittedPackIds(pack)]).toEqual(['under-floor']);
    expect(pack.facts?.[0]?.admitted_by?.rule).toBe('assessment');
    expect(pack.rendered_text).toContain('selected by assessment over the floor: vector 0.22');
    expect(pack.metadata.assessment).toMatchObject({ outcome: 'selected', shown: 3, selected: 1 });
    expect(pack.metadata.degraded).toBeUndefined();
    expect(effects).toBe('persisted');
    // Delivery is what was served, and holdings follow it, the chosen refusal included.
    expect([...(completions[0]?.emitted ?? [])]).toEqual(['under-floor']);
    expect(completions[0]?.retrieved).toEqual(expect.arrayContaining(['top', 'under-floor']));
    expect([...readServedItems(store.db, IDENTITY).keys()]).toEqual(['under-floor']);
  });

  it('keeps what the session already holds out of view, and still says it withheld it', async () => {
    await recall(() => Promise.resolve({ selected: [1, 2] }));

    const second = await recall(() => Promise.resolve({ selected: [] }));

    const shown = second.requests[0]?.messages[1]?.content ?? '';
    expect(shown).not.toContain('admitted memory top');
    expect(shown).toContain('we chose Valkey');
    expect(second.pack.metadata.suppressed_repeats).toBe(2);
    expect(second.pack.rendered_text).toContain('2 items already served this session');
    expect([...readServedItems(store.db, IDENTITY).keys()].sort()).toEqual(['second', 'top']);
  });

  it('keeps the model order across the pack', async () => {
    const { pack } = await recall(() => Promise.resolve({ selected: [3, 2] }));

    expect(pack.facts?.map((entry) => [entry.id, entry.rank])).toEqual([
      ['under-floor', 1],
      ['second', 2],
    ]);
  });

  it('serves nothing when the model chose nothing, and says it was a judgment', async () => {
    const { pack } = await recall(() =>
      Promise.resolve({ selected: [], note: 'none of these are about the licence' }),
    );

    expect([...emittedPackIds(pack)]).toEqual([]);
    expect(pack.rendered_text).toContain('the assessment judged none of them useful here');
    expect(pack.rendered_text).toContain('assessment says: none of these are about the licence');
    expect(pack.metadata.degraded).toBeUndefined();
    expect(completions[0]?.emitted.size).toBe(0);
  });

  it('falls back to the ranking and discloses it when the call fails', async () => {
    const { pack } = await recall(() => Promise.reject(new Error('503 overloaded')));

    expect([...emittedPackIds(pack)]).toEqual(['top', 'second']);
    expect(pack.metadata.degraded).toEqual([{ stage: 'assessment', reason: 'model_error' }]);
    expect(pack.metadata.assessment?.outcome).toBe('fallback');
    expect(pack.rendered_text).toContain('degraded memory assessment');
  });

  it('drops a selection whose evidence moved before it was recorded, and serves the ranking', async () => {
    declineWith = 'pending_publication';

    const { pack, effects } = await recall(() =>
      Promise.resolve({ selected: [3], note: 'only the licence decision helps' }),
    );

    expect(effects).toBe('withheld');
    expect(pack.metadata.assessment?.note).toBeUndefined();
    expect(pack.rendered_text).not.toContain('assessment says');
    expect([...emittedPackIds(pack)]).toEqual(['top', 'second']);
    expect(pack.metadata.assessment).toMatchObject({ outcome: 'discarded', selected: 0 });
    expect([...(completions[0]?.emitted ?? [])]).toEqual(['top', 'second']);
  });
});
