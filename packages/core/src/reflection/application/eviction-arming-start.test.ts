import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { armEvictionOnStart, evictionArmOnStartOperationId } from './eviction-arming-start.js';
import { EVICTION_COMPATIBILITY_REVISION } from './eviction-arming.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { claimEvictionStop } from '../../infrastructure/sqlite/publication-control.js';

/**
 * The branches of the start-time arm that must not publish anything, against a real substrate
 * record and a coordinator that fails the test if it is asked to publish.
 *
 * The publishing path is an integration case (`eviction-arming.int.test.ts`): it takes the graph
 * guard and the whole receipt, which is the point of it. What is here is the other half — every
 * state in which the service has to leave the fence exactly as it found it.
 */

const REFUSES = {
  publish: () => {
    throw new Error('the start arm published on a path that must not publish');
  },
} as unknown as PublicationCoordinator;

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

function control(columns: string, values: string): void {
  store.db
    .prepare(
      `INSERT INTO publication_control
         (substrate_id, bootstrap_state, protocol_version${columns})
       VALUES ('s1', 'initialized', 1${values})`,
    )
    .run();
}

function activeContract(): void {
  store.db
    .prepare(
      `INSERT INTO coverage_contract
         (epoch, history_since, activated_at, field_policy_version, state)
       VALUES ('epoch-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 1, 'active')`,
    )
    .run();
}

describe('what the start-time arm refuses to touch', () => {
  it('leaves a substrate with no control record unarmed and says so', async () => {
    expect(await armEvictionOnStart(REFUSES, store.db)).toEqual({
      state: 'unarmed',
      reason: 'substrate_pairing_missing',
    });
  });

  it('keeps a disarmed substrate disarmed across a restart', async () => {
    // The rule the operator relies on: a stop is a statement, and a restart is not a retraction
    // of it. Reported as disarmed rather than as a refusal, because nothing is wrong here.
    control(
      ', eviction_compatibility_revision, eviction_disarmed_at',
      ", 1, '2026-09-12T09:00:00.000Z'",
    );
    activeContract();

    expect(await armEvictionOnStart(REFUSES, store.db)).toEqual({
      state: 'disarmed',
      at: '2026-09-12T09:00:00.000Z',
    });
  });

  it('refuses over a stop that was asked for and never recorded', async () => {
    // What a crashed disarm leaves. Arming would clear it, and clearing it loses the record that
    // somebody asked to stop, so the start does not take that decision.
    control('', '');
    activeContract();
    claimEvictionStop(store.db, 'disarm-that-never-finished');

    expect(await armEvictionOnStart(REFUSES, store.db)).toEqual({
      state: 'unarmed',
      reason: 'eviction_stop_owed',
    });
  });

  it('reads an already-armed fence without publishing a second receipt', async () => {
    control(', eviction_compatibility_revision', ', 1');
    activeContract();

    expect(await armEvictionOnStart(REFUSES, store.db)).toEqual({
      state: 'armed',
      revision: EVICTION_COMPATIBILITY_REVISION,
    });
  });

  it('names the missing coverage registry rather than asking the coordinator', async () => {
    control('', '');

    expect(await armEvictionOnStart(REFUSES, store.db)).toEqual({
      state: 'unarmed',
      reason: 'coverage_registry_missing',
    });
  });
});

describe('the identity the start-time arm publishes under', () => {
  const facts = {
    revision: EVICTION_COMPATIBILITY_REVISION,
    coverageEpoch: 'epoch-1',
    coverageState: 'active',
    bootstrapState: 'initialized',
    activationCapabilityRevision: 1,
    installedKinds: ['intake', 'episode_eviction', 'eviction_arming'],
  };

  it('is the same for the same facts, and carries no moment', () => {
    // A moment in the identity would make every boot its own decision with its own receipt. One
    // set of facts, one arming: a restart that finds them unchanged republishes the same operation
    // and gets its recorded outcome, which under unchanged facts is still the right one.
    expect(evictionArmOnStartOperationId(facts)).toBe(evictionArmOnStartOperationId(facts));
    expect(evictionArmOnStartOperationId(facts)).toContain(
      `eviction-arm:${String(EVICTION_COMPATIBILITY_REVISION)}:epoch-1:active:initialized:1:`,
    );
  });

  it('moves when any fact the check reads moves', () => {
    // The coordinator replays a recorded outcome for an identity it has seen without re-checking
    // it, so a fact missing from here is a refusal that outlives the condition that caused it.
    const moved = [
      { ...facts, coverageEpoch: 'epoch-2' },
      { ...facts, coverageState: 'preparing' },
      { ...facts, bootstrapState: 'pairing' },
      { ...facts, activationCapabilityRevision: 0 },
      { ...facts, revision: 2 },
      // The one that made this a defect rather than a nicety: a process composing a smaller
      // handler set records `writer_audit_incomplete`, and the full composition has to be able to
      // arm afterwards.
      { ...facts, installedKinds: ['intake', 'eviction_arming'] },
    ];

    for (const one of moved) {
      expect(evictionArmOnStartOperationId(one)).not.toBe(evictionArmOnStartOperationId(facts));
    }
  });

  it('reads the composition as a set, since registration order is not a fact', () => {
    expect(
      evictionArmOnStartOperationId({
        ...facts,
        installedKinds: ['eviction_arming', 'episode_eviction', 'intake'],
      }),
    ).toBe(evictionArmOnStartOperationId(facts));
  });
});
