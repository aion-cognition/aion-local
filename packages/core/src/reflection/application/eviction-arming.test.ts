import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  armingPreconditions,
  EVICTION_COMPATIBILITY_REVISION,
  evictionArmingPublication,
} from './eviction-arming.js';
import { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import {
  PUBLICATION_KINDS,
  PUBLICATION_PROTOCOL_VERSION,
  type PublicationAckContext,
  type PublicationContext,
  type PublicationKind,
  type PublicationPlan,
} from '../../infrastructure/publication/types.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
  readCurrentCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  beginSubstratePairing,
  completeSubstratePairing,
  establishActivationCapability,
  readSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';

/**
 * The arming act, which is the only thing that lets eviction remove anything.
 *
 * Fail-closed in every direction: each precondition refuses on its own, a refusal writes nothing,
 * and the fence a refused attempt leaves behind reads exactly as it did before. The composition
 * check is the one a caller cannot talk its way past, since the kinds come from the coordinator's
 * own map rather than from the request.
 */

const NOW = '2026-09-12T10:00:00.000Z';

let store: SqliteStore;

function armedRevision(): number {
  return readSubstratePairing(store.db)?.evictionCompatibilityRevision ?? 0;
}

/** Every precondition satisfied, which is the state the refusal cases each take one thing from. */
function seedReadySubstrate(): void {
  const pairing = beginSubstratePairing(store.db, PUBLICATION_PROTOCOL_VERSION);
  completeSubstratePairing(store.db, pairing.substrateId);
  prepareCoverageContract(store.db, 1);
  establishActivationCapability(store.db, 1);
  activateCoverageContract(store.db, {
    activatedAt: new Date(NOW),
    fieldPolicyVersion: 1,
    operationId: 'coverage-activation:fixture',
  });
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

function failing(kinds: readonly PublicationKind[], revision: number): readonly string[] {
  return armingPreconditions(store.db, kinds, revision)
    .filter((precondition) => !precondition.holds)
    .map((precondition) => precondition.reason);
}

function plan(revision: number, coverageEpoch: string): PublicationPlan {
  return {
    data: { revision, coverageEpoch },
    expected: {
      coverageEpoch,
      evidence: buildEvidenceRevision([]),
      sources: [],
      heads: [],
    },
    scopes: [],
    effects: [{ kind: 'eviction_control', detail: { revision } }],
  };
}

function context(kinds: readonly PublicationKind[]): PublicationContext {
  return {
    operationId: 'arm',
    sequence: null,
    graph: new GraphTransaction({
      run: () => {
        throw new Error('arming reads no graph');
      },
    }),
    db: store.db,
    now: new Date(NOW),
    installedKinds: [...kinds],
  };
}

function ackContext(): PublicationAckContext {
  return {
    operationId: 'arm',
    sequence: '1',
    db: store.db,
    knownFrom: NOW,
    observedAckAt: NOW,
    clockClamped: false,
  };
}

it('holds every precondition on a substrate that is ready to arm', () => {
  seedReadySubstrate();
  expect(failing(PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION)).toEqual([]);
});

it('refuses while any declared kind has no installed handler', () => {
  seedReadySubstrate();
  const short = PUBLICATION_KINDS.filter((kind) => kind !== 'episode_eviction');
  expect(failing(short, EVICTION_COMPATIBILITY_REVISION)).toContain('writer_audit_incomplete');
});

it('refuses on an unfinished bootstrap, an unestablished capability and a preparing contract', () => {
  // Nothing seeded: a bare substrate fails all three at once, which is the state a fresh install
  // is in and the state arming must never pass in.
  prepareCoverageContract(store.db, 1);
  expect(failing(PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION)).toEqual([
    'substrate_not_initialized',
    'coverage_capability_not_established',
    'coverage_contract_not_active',
  ]);
});

it('refuses a revision this build does not implement', () => {
  seedReadySubstrate();
  expect(failing(PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION + 1)).toContain(
    'arming_revision_not_this_build',
  );
});

it('refuses to arm a fence that already reads at that revision', () => {
  seedReadySubstrate();
  evictionArmingPublication.acknowledgeSqlite(
    ackContext(),
    plan(EVICTION_COMPATIBILITY_REVISION, readCurrentCoverageContract(store.db)!.epoch),
    { revision: EVICTION_COMPATIBILITY_REVISION },
  );
  expect(failing(PUBLICATION_KINDS, EVICTION_COMPATIBILITY_REVISION)).toEqual(['already_armed']);
});

it('answers the check with the first precondition that fails, and writes nothing', async () => {
  prepareCoverageContract(store.db, 1);
  const { epoch } = readCurrentCoverageContract(store.db)!;

  await expect(
    evictionArmingPublication.check(
      context(PUBLICATION_KINDS),
      plan(EVICTION_COMPATIBILITY_REVISION, epoch),
    ),
  ).resolves.toEqual({ status: 'deferred', reason: 'substrate_not_initialized' });
  expect(armedRevision()).toBe(0);
});

it('binds the epoch the operator asked under, which is what the coverage fence compares', async () => {
  seedReadySubstrate();
  const prepared = await evictionArmingPublication.prepare(context(PUBLICATION_KINDS), {
    revision: EVICTION_COMPATIBILITY_REVISION,
    coverageEpoch: 'an-older-epoch',
  });
  // The coordinator refuses `coverage_epoch_changed` on this field before the handler is asked,
  // so the request carries its own epoch rather than picking up whichever is current here.
  expect(prepared.expected.coverageEpoch).toBe('an-older-epoch');
  expect(armedRevision()).toBe(0);
});

it('admits the act and arms the fence in the acknowledgment', async () => {
  seedReadySubstrate();
  const { epoch } = readCurrentCoverageContract(store.db)!;
  const armed = plan(EVICTION_COMPATIBILITY_REVISION, epoch);

  await expect(evictionArmingPublication.check(context(PUBLICATION_KINDS), armed)).resolves.toEqual(
    { status: 'valid' },
  );
  expect(armedRevision()).toBe(0);

  evictionArmingPublication.acknowledgeSqlite(ackContext(), armed, {
    revision: EVICTION_COMPATIBILITY_REVISION,
  });
  expect(armedRevision()).toBe(EVICTION_COMPATIBILITY_REVISION);
});

it('leaves the fence where it was when the act is discarded', () => {
  seedReadySubstrate();
  const { epoch } = readCurrentCoverageContract(store.db)!;
  evictionArmingPublication.discardSqlite(
    { operationId: 'arm', sequence: '1', db: store.db },
    plan(EVICTION_COMPATIBILITY_REVISION, epoch),
    'writer_audit_incomplete',
  );
  expect(armedRevision()).toBe(0);
});
