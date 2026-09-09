import type { MemoryPack } from '@aion/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCheckedRecall, type CheckedRecallDeps } from './checked-recall.js';
import { CueCache } from './cues.js';
import type { ReadCoordinator } from './read-completion.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
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
const BEFORE_HORIZON = '2026-09-01T00:00:00.000Z';

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
let generateCalls = 0;
let embedCalls = 0;
let recalled = 0;
/** The pack the delivered-answer listener was handed, which must be the one the caller got. */
let notified: MemoryPack | undefined;
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
    generateCalls += 1;
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
    onRecalled: (completion) => {
      recalled += 1;
      notified = completion.pack;
    },
  };
}

function activate(at: Date = ACTIVATED_AT): void {
  activateCoverageContract(store.db, { activatedAt: at, fieldPolicyVersion: 1 });
}

/** Reversibly: every fixture puts the substrate back the way it found it. */
function hideRegistry(): void {
  store.db.prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_hidden').run();
}

function restoreRegistry(): void {
  store.db.prepare('ALTER TABLE coverage_contract_hidden RENAME TO coverage_contract').run();
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
  generateCalls = 0;
  embedCalls = 0;
  recalled = 0;
  notified = undefined;
  position = { status: 'ready', checkpoint: CHECKPOINT };
  declineWith = undefined;
  atBoundary = undefined;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a refused request', () => {
  it('refuses knowledge time before the horizon without spending anything', async () => {
    activate();

    const outcome = await recall({ knew_at: BEFORE_HORIZON, reset_delivery_suppression: true });

    expect(outcome).toEqual({
      status: 'coverage_refusal',
      refusal: {
        contract_version: 1,
        reason: 'before_horizon',
        requested: { knew_at: BEFORE_HORIZON, now: NOW.toISOString() },
        bounds: { history_since: ACTIVATED_AT.toISOString(), coverage_state: 'active' },
      },
    });
    // The whole reason the check comes first: no cue call, no embedding, no session, no pack,
    // and the holdings the caller asked to forget are still there.
    expect([generateCalls, embedCalls]).toEqual([0, 0]);
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
    expect(recalled).toBe(0);
  });

  it('refuses a present request when the registry cannot be read at all', async () => {
    activate();
    hideRegistry();

    try {
      expect(await recall()).toMatchObject({
        status: 'coverage_refusal',
        refusal: { reason: 'coverage_store_unavailable', bounds: {} },
      });
    } finally {
      restoreRegistry();
    }
    expect([generateCalls, embedCalls]).toEqual([0, 0]);
  });

  it('refuses knowledge time past the request clock', async () => {
    activate();

    expect(await recall({ knew_at: '2026-09-09T00:00:00.000Z' })).toMatchObject({
      status: 'coverage_refusal',
      refusal: { reason: 'future_knowledge' },
    });
    expect([generateCalls, embedCalls]).toEqual([0, 0]);
  });
});

describe('a served request', () => {
  it('records its effects and its staged reset at the boundary', async () => {
    activate();

    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome.status).toBe('pack');
    expect(outcome).toMatchObject({ effects: 'persisted' });
    expect(getLastPack(store.db, IDENTITY)).toBeDefined();
    expect(holdings()).toEqual([]);
    expect(recalled).toBe(1);
  });

  it('answers a preparing contract as supported and names it, at its configured cost', async () => {
    const outcome = await recall();

    expect(outcome).toMatchObject({
      status: 'pack',
      effects: 'persisted',
      pack: {
        metadata: {
          history_coverage: {
            status: 'supported',
            limitations: ['coverage_contract_not_active'],
          },
        },
      },
    });
    // No invented boundary while the record is preparing, and the calls a real retrieval makes
    // are the calls it makes: the zero-cost guarantee belongs to preflight refusal alone.
    expect(
      (outcome as { pack: { metadata: { history_coverage?: { history_since?: string } } } }).pack
        .metadata.history_coverage?.history_since,
    ).toBeUndefined();
    expect(embedCalls).toBeGreaterThan(0);
  });

  it('answers a temporal request as partial while the contract is preparing', async () => {
    const outcome = await recall({ knew_at: '2026-09-07T00:00:00.000Z' });

    expect(outcome).toMatchObject({
      status: 'pack',
      pack: { metadata: { history_coverage: { status: 'partial' } } },
    });
  });
});

/**
 * F11 D6: the text says what the JSON says. A caller reading only the block is the one who
 * would otherwise take a partial answer for a complete one, so every limitation and gap the
 * metadata carries is in the words too, and an ordinary answer stays ordinary.
 */
describe('what the rendered text says', () => {
  function renderedOf(outcome: Awaited<ReturnType<typeof recall>>): string {
    if (outcome.status !== 'pack') {
      throw new Error('this case serves an answer');
    }
    return outcome.pack.rendered_text;
  }

  it('says nothing extra on an ordinary present answer', async () => {
    activate();

    expect(renderedOf(await recall())).not.toContain('history:');
  });

  it('names the preparing contract in the words the metadata uses', async () => {
    expect(renderedOf(await recall())).toContain('coverage_contract_not_active');
  });

  it('states the boundary and the request on a temporal answer', async () => {
    activate();

    const text = renderedOf(await recall({ knew_at: '2026-09-08T06:00:00.000Z' }));

    expect(text).toContain('covered since 2026-09-08T02:00:00.000Z');
    expect(text).toContain('knew_at 2026-09-08T06:00:00.000Z');
  });

  it('names the publication it could not record behind', async () => {
    activate();
    position = { status: 'unavailable', reason: 'pending_publication' };

    expect(renderedOf(await recall())).toContain('pending_publication');
  });
});

describe('a temporal read that succeeds', () => {
  it('keeps its artifact and its exemptions', async () => {
    activate();

    const outcome = await recall({ knew_at: '2026-09-08T06:00:00.000Z' });

    expect(outcome).toMatchObject({ status: 'pack', effects: 'persisted' });
    // Its own artifact and diagnostics are retained; delivery suppression, the holdings record
    // and the intention trigger are not evaluated at all.
    expect(getLastPack(store.db, IDENTITY)).toBeDefined();
    expect(holdings()).toEqual(['held']);
    expect(graph.statements.filter((s) => s.cypher.includes('Intention'))).toEqual([]);
    // The mode the pipeline read with is the one the checker pinned, which is what every
    // exemption above hangs off.
    expect(graph.statements.some((s) => s.cypher.includes('tx_from'))).toBe(true);
  });
});

describe('a contract that moves under the read', () => {
  it('refuses at the boundary and leaves the holdings alone', async () => {
    activate();
    atBoundary = () => {
      activate(new Date('2026-09-08T03:00:00.000Z'));
    };

    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome).toMatchObject({
      status: 'coverage_refusal',
      refusal: { reason: 'coverage_changed', bounds: { coverage_state: 'active' } },
    });
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
    // Nothing the caller never received is reinforced or stamped.
    expect(recalled).toBe(0);
    // The work it did before the contract moved was still spent, and the refusal never says
    // otherwise: the provider was called.
    expect(embedCalls).toBeGreaterThan(0);
  });

  /**
   * F11-A16's last leg: activation is an epoch change like any other, so a read that began
   * under the preparing record revalidates at the boundary rather than being served under the
   * contract that replaced it.
   */
  it('refuses a read that began while the contract was still preparing', async () => {
    atBoundary = () => {
      activate();
    };

    expect(await recall({ knew_at: '2026-09-08T06:00:00.000Z' })).toMatchObject({
      status: 'coverage_refusal',
      refusal: {
        reason: 'coverage_changed',
        bounds: { coverage_state: 'active', history_since: ACTIVATED_AT.toISOString() },
      },
    });
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
  });

  it('refuses when the registry stops being readable under the read', async () => {
    activate();
    atBoundary = hideRegistry;

    try {
      expect(await recall()).toMatchObject({
        status: 'coverage_refusal',
        refusal: { reason: 'coverage_store_unavailable', bounds: {} },
      });
    } finally {
      restoreRegistry();
    }
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
  });
});

describe('a publication the boundary will not commit behind', () => {
  it('serves the answer and records nothing when no position could be taken', async () => {
    activate();
    position = { status: 'unavailable', reason: 'pending_publication' };

    const outcome = await recall();

    // Partial because the evidence behind the answer was never certified, which is a fact about
    // the evidence and not about what the request asked for.
    expect(outcome).toMatchObject({
      status: 'pack',
      effects: 'withheld',
      pack: {
        metadata: {
          history_coverage: {
            status: 'partial',
            gaps: [{ field: 'interpretation_text', reason: 'pending_publication' }],
          },
        },
      },
    });
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
  });

  it('discloses an unfulfilled reset beside the answer, as its own statement', async () => {
    activate();
    position = { status: 'unavailable', reason: 'pending_publication' };

    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome).toMatchObject({
      status: 'pack',
      effects: 'withheld',
      pack: {
        metadata: {
          history_coverage: {
            status: 'partial',
            gaps: [
              { field: 'interpretation_text', reason: 'pending_publication' },
              { field: 'eligibility', reason: 'pending_publication' },
            ],
          },
        },
      },
    });
    expect(holdings()).toEqual(['held']);
  });

  it('serves without recording when the position it held has moved', async () => {
    activate();
    declineWith = 'publication_changed';

    const outcome = await recall({ reset_delivery_suppression: true });

    expect(outcome).toMatchObject({ status: 'pack', effects: 'withheld' });
    expect(getLastPack(store.db, IDENTITY)).toBeUndefined();
    expect(holdings()).toEqual(['held']);
  });

  /**
   * The rebuilt answer is the delivered one, so nothing downstream describes the artifact the
   * boundary withdrew: exposure and reinforcement are charged against what the caller received.
   */
  it('hands the listener the answer it rebuilt', async () => {
    activate();
    declineWith = 'publication_changed';

    const outcome = await recall();

    expect(outcome.status).toBe('pack');
    expect(notified).toBe(outcome.status === 'pack' ? outcome.pack : undefined);
  });

  /** R4's other half: a decline at the end carries its own word into the statement too. */
  it('names a store the boundary could not read as a store failure', async () => {
    activate();
    declineWith = 'store_unavailable';

    const outcome = await recall();

    expect(outcome).toMatchObject({
      status: 'pack',
      effects: 'withheld',
      pack: {
        metadata: {
          history_coverage: {
            gaps: [{ field: 'interpretation_text', reason: 'store_unavailable' }],
          },
        },
      },
    });
  });

  it('refuses rather than degrading when the registry moved too', async () => {
    activate();
    declineWith = 'publication_changed';
    atBoundary = () => {
      activate(new Date('2026-09-08T04:00:00.000Z'));
    };

    expect(await recall()).toMatchObject({
      status: 'coverage_refusal',
      refusal: { reason: 'coverage_changed' },
    });
  });
});
