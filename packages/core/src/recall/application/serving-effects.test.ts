import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkCoverage, type CheckedRead } from './coverage-checker.js';
import { completeCheckedRead, type ReadCoordinator } from './read-completion.js';
import { servingEffects, withCoverage, type ServingEffectsInput } from './serving-effects.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { knewAt } from '../../infrastructure/graph/read-modes.js';
import type { PublicationCheckpoint } from '../../infrastructure/publication/types.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { recallCadenceCounters } from '../../infrastructure/sqlite/recall-cadence.js';
import { cueDegradedRate } from '../../infrastructure/sqlite/recall-samples.js';
import { readServedItems, recordServedItems } from '../../infrastructure/sqlite/served-items.js';
import type { AdmissionPolicy } from '../domain/admission.js';
import type { FusedItem } from '../domain/fusion.js';
import { assemble, item } from '../domain/test-support/pack.fixture.js';
import { viewOf } from '../domain/test-support/resolved-view.fixture.js';

/**
 * The successful-read effects as the completion boundary takes them: two synchronous callbacks
 * over one handle, with the reset held apart from everything else.
 */

const NOW = new Date('2026-09-08T12:00:00.000Z');
const SESSION = 'session-a';
const PROVENANCE: ItemProvenance = { roots: ['ep-1'], complete: true };

const POLICY: AdmissionPolicy = {
  vectorFloor: 0.5,
  corroborationFloor: 0.4,
  bm25Mode: 'corroborated',
};

function effectsFor(overrides: Partial<ServingEffectsInput> = {}): ServingEffectsInput {
  const items = [item('e1'), item('e2')];
  return {
    sessionId: SESSION,
    now: NOW,
    mode: {},
    pack: assemble(items),
    temporal: {},
    admission: { policy: POLICY, items },
    candidates: new Map(items.map((entry) => [entry.id, entry])),
    view: viewOf({ provenance: new Map(items.map((entry) => [entry.id, PROVENANCE])) }),
    suppressed: new Set(),
    dedup: true,
    cueDegraded: false,
    methodStats: {},
    resonantCount: 0,
    empty: false,
    resetDelivery: false,
    ...overrides,
  };
}

describe('what a successful read writes', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-serving-effects-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('records the pack, the holdings, the cue outcome and the cadence in one pass', () => {
    servingEffects(effectsFor()).persist(store.db);

    expect(getLastPack(store.db, SESSION)?.packJson).toContain('token_estimate');
    expect([...readServedItems(store.db, SESSION).keys()].sort()).toEqual(['e1', 'e2']);
    expect(cueDegradedRate(store.db)).toBe(0);
    expect(recallCadenceCounters(store.db).totalCalls).toBe(1);
  });

  it('offers no reset callback where the caller asked for none', () => {
    expect(servingEffects(effectsFor()).resetDelivery).toBeUndefined();
  });

  /**
   * The rows go at the boundary, not when the request arrives. A read that computed against an
   * empty served set and then refused leaves the caller holding everything it was told.
   */
  it('holds a requested reset back until the boundary runs it', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'old', fingerprint: 'f' }], NOW.toISOString());
    const effects = servingEffects(effectsFor({ resetDelivery: true }));

    expect([...readServedItems(store.db, SESSION).keys()]).toEqual(['old']);

    effects.resetDelivery?.(store.db);
    effects.persist(store.db);

    expect([...readServedItems(store.db, SESSION).keys()].sort()).toEqual(['e1', 'e2']);
  });

  /**
   * A temporal read never suppresses, so recording what it served would let a historical
   * inspection decide what the present-day pack may repeat. The pack itself, the counters and an
   * explicitly requested reset are all still permitted.
   */
  it('writes no holdings on a temporal read and still writes the pack and the counters', () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'old', fingerprint: 'f' }], NOW.toISOString());
    const effects = servingEffects(
      effectsFor({ mode: knewAt(NOW), dedup: false, resetDelivery: true }),
    );
    effects.resetDelivery?.(store.db);
    effects.persist(store.db);

    expect([...readServedItems(store.db, SESSION).keys()]).toEqual([]);
    expect(getLastPack(store.db, SESSION)?.packJson).toContain('token_estimate');
    expect(recallCadenceCounters(store.db).totalCalls).toBe(1);
    expect(cueDegradedRate(store.db)).toBe(0);
  });

  it('records no typed admission on a temporal read', () => {
    const typed: FusedItem = {
      ...item('e1'),
      admittedBy: { rule: 'typed_admission', score: 0.8, qualifying: ['vector 0.80'] },
      typedEvidence: { edgeType: 'CAUSES', contribution: 0.3 },
    };
    for (const [mode, expected] of [
      [{}, 1],
      [knewAt(NOW), 0],
    ] as const) {
      const fresh = new SqliteStore({
        filePath: join(dir, `admissions-${String(expected)}.sqlite`),
      });
      servingEffects(effectsFor({ mode, admission: { policy: POLICY, items: [typed] } })).persist(
        fresh.db,
      );
      const rows = fresh.db
        .prepare("SELECT count(*) AS n FROM ops_ledger WHERE key LIKE 'typed_admission:%'")
        .get() as { readonly n: number };

      expect(rows.n).toBe(expected);
      fresh.close();
    }
  });
});

/**
 * The shared boundary takes these callbacks as they are. Nothing here is a second reset or a
 * second effect implementation: the fence on the coverage contract and the writes commit in one
 * transaction, and a read that finished under a contract that moved leaves the holdings alone.
 */
describe('the effects at the completion boundary', () => {
  const CHECKPOINT: PublicationCheckpoint = {
    substrateId: 'substrate-1',
    protocolVersion: 1,
    sequence: '4',
    operationId: null,
    intentDigest: null,
    resultDigest: null,
  };
  const STUB_GRAPH = new GraphTransaction({
    run: () => {
      throw new Error('the graph half is inert here');
    },
  });

  let dir: string;
  let store: SqliteStore;

  const coordinator: ReadCoordinator = {
    checkpoint: () => Promise.resolve({ status: 'ready', checkpoint: CHECKPOINT }),
    async completeRead(_checkpoint, validate, complete) {
      const valid = await validate({
        operationId: 'read_completion',
        sequence: null,
        graph: STUB_GRAPH,
        db: store.db,
        now: NOW,
      });
      if (!valid) {
        return { status: 'retry', reason: 'evidence_changed' };
      }
      return { status: 'completed', value: store.db.transaction(() => complete(store.db))() };
    },
  };

  function checked(): CheckedRead {
    const result = checkCoverage(store.db, { now: NOW, expiryAnnotation: true });
    if (result.status !== 'checked') {
      throw new Error('the fixture contract answers');
    }
    return { context: result.context, coverage: result.coverage };
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-serving-boundary-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, {
      activatedAt: new Date('2026-09-08T02:00:00.000Z'),
      fieldPolicyVersion: 1,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('commits the holdings and the staged reset through the shared helper', async () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'old', fingerprint: 'f' }], NOW.toISOString());
    const effects = servingEffects(effectsFor({ resetDelivery: true }));
    const outcome = await completeCheckedRead(
      { coordinator, db: store.db },
      { read: checked(), checkpoint: CHECKPOINT, ...effects },
    );

    expect(outcome.status).toBe('completed');
    expect([...readServedItems(store.db, SESSION).keys()].sort()).toEqual(['e1', 'e2']);
  });

  /**
   * The contract moved while the answer was being computed, so the effects are held back whole.
   * A caller that had asked to forget its holdings still holds them.
   */
  it('writes nothing when the contract moved under the read', async () => {
    recordServedItems(store.db, SESSION, [{ itemId: 'old', fingerprint: 'f' }], NOW.toISOString());
    const read = checked();
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, {
      activatedAt: new Date('2026-09-08T03:00:00.000Z'),
      fieldPolicyVersion: 1,
    });
    const effects = servingEffects(effectsFor({ resetDelivery: true }));
    const outcome = await completeCheckedRead(
      { coordinator, db: store.db },
      { read, checkpoint: CHECKPOINT, ...effects },
    );

    expect(outcome.status).toBe('refused');
    expect([...readServedItems(store.db, SESSION).keys()]).toEqual(['old']);
    expect(getLastPack(store.db, SESSION)).toBeUndefined();
  });
});

describe('the coverage the answer carries', () => {
  it('folds the attempt evidence gaps into the checked statement', () => {
    const base = {
      contract_version: 1 as const,
      status: 'supported' as const,
      limitations: [],
      gaps: [],
    };
    const withGap = withCoverage(
      assemble([item('e1')]),
      base,
      viewOf({
        issues: [
          {
            address: idAddress('e1'),
            field: 'ownership',
            reason: 'store_unavailable',
            required: true,
          },
        ],
      }),
    );

    expect(withGap.metadata.history_coverage).toEqual({
      ...base,
      status: 'partial',
      gaps: [{ id: 'e1', field: 'ownership', reason: 'store_unavailable' }],
    });
  });

  it('leaves a clean statement supported and the rest of the pack untouched', () => {
    const pack = assemble([item('e1')]);
    const base = {
      contract_version: 1 as const,
      status: 'supported' as const,
      limitations: [],
      gaps: [],
    };
    const served = withCoverage(pack, base, viewOf());

    expect(served.metadata.history_coverage).toEqual(base);
    expect(served.rendered_text).toBe(pack.rendered_text);
    expect(served.metadata.token_estimate).toBe(pack.metadata.token_estimate);
  });
});
