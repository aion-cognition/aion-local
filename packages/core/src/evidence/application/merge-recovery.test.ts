import { describe, expect, it, vi } from 'vitest';

import { applyMergeWithRecovery, type MergeCoordinator } from './merge-recovery.js';
import {
  PublicationInvariantError,
  PublicationPendingError,
} from '../../infrastructure/publication/errors.js';
import type { PublicationOutcome } from '../../infrastructure/publication/types.js';

const logger = { warn: vi.fn() };

function coordinator(overrides: Partial<MergeCoordinator> = {}): MergeCoordinator {
  return {
    hasPending: () => false,
    recover: () => Promise.resolve(undefined),
    ...overrides,
  };
}

function acknowledged(operationId: string): PublicationOutcome {
  return {
    status: 'acknowledged',
    operationId,
    sequence: '7',
    result: { merged: true },
    knownFrom: '2026-09-08T10:00:00.000Z',
    observedAckAt: '2026-09-08T10:00:00.000Z',
    clockClamped: false,
  };
}

describe('merge apply recovery', () => {
  it('returns what the merge produced when it lands', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-a',
      attempt: () => Promise.resolve({ merged: true }),
      logger,
    });

    expect(outcome).toEqual({ status: 'applied', value: { merged: true } });
  });

  it('counts one transient failure as one failed pair and leaves the pair retryable', async () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-b',
      attempt: () => Promise.reject(busy),
      logger,
    });

    expect(outcome).toEqual({ status: 'failed', reason: 'store_busy' });
  });

  it('propagates an invariant failure rather than recording it as a failed pair', async () => {
    await expect(
      applyMergeWithRecovery({
        operationId: 'pair-c',
        attempt: () => Promise.reject(new PublicationInvariantError('pairing_mismatch')),
        logger,
      }),
    ).rejects.toBeInstanceOf(PublicationInvariantError);
  });

  it('settles an uncertain commit through the receipt rather than merging again', async () => {
    const recover = vi.fn(() => Promise.resolve(acknowledged('pair-d')));
    const attempt = vi.fn(() =>
      Promise.reject(new PublicationPendingError('pair-d', new Error('commit response lost'))),
    );
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-d',
      attempt,
      coordinator: coordinator({ recover }),
      logger,
    });

    expect(outcome).toEqual({
      status: 'settled',
      operationId: 'pair-d',
      result: { merged: true },
    });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('propagates a pairing invariant raised while reconciling an uncertain commit', async () => {
    const failure = new PublicationInvariantError('pairing_mismatch');

    await expect(
      applyMergeWithRecovery({
        operationId: 'merge',
        attempt: () => Promise.reject(new PublicationPendingError('merge', new Error('uncertain'))),
        coordinator: coordinator({
          hasPending: () => true,
          recover: () => Promise.reject(failure),
        }),
        logger,
      }),
    ).rejects.toBe(failure);
  });

  it('settles on the receipt another actor left behind', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-elsewhere',
      attempt: () =>
        Promise.reject(new PublicationPendingError('pair-elsewhere', new Error('lost'))),
      coordinator: coordinator({ outcomeOf: () => acknowledged('pair-elsewhere') }),
      logger,
    });

    expect(outcome).toEqual({
      status: 'settled',
      operationId: 'pair-elsewhere',
      result: { merged: true },
    });
  });

  it('stops rather than guess at an operation whose outcome it cannot read', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-unknown',
      attempt: () => Promise.reject(new PublicationPendingError('pair-unknown', new Error('lost'))),
      coordinator: coordinator({}),
      logger,
    });

    expect(outcome).toEqual({ status: 'halted', reason: 'uncertain_commit_unresolved' });
  });

  it('counts an uncertain commit that never landed as a failed pair', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-e',
      attempt: () => Promise.reject(new PublicationPendingError('pair-e', new Error('lost'))),
      coordinator: coordinator({
        recover: () =>
          Promise.resolve({
            status: 'deferred',
            operationId: 'pair-e',
            sequence: '8',
            reason: 'evidence_changed',
          }),
      }),
      logger,
    });

    expect(outcome).toEqual({ status: 'failed', reason: 'pending_recovery' });
  });

  it('stops the batch when an uncertain publication cannot be reconciled', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-f',
      attempt: () => Promise.reject(new PublicationPendingError('pair-f', new Error('lost'))),
      logger,
    });

    expect(outcome).toEqual({
      status: 'halted',
      reason: 'uncertain_commit_without_coordinator',
    });
  });

  it('halts when recovery leaves the original publication deferred and still pending', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'merge',
      attempt: () => Promise.reject(new PublicationPendingError('merge', new Error('lost'))),
      logger,
      coordinator: coordinator({
        hasPending: () => true,
        recover: () =>
          Promise.resolve({
            status: 'deferred',
            operationId: 'merge',
            sequence: '1',
            reason: 'evidence_changed',
          }),
      }),
    });

    expect(outcome.status).toBe('halted');
  });

  it('stops the batch when recovery leaves the coordinator holding the slot', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-g',
      attempt: () => Promise.reject(new PublicationPendingError('pair-g', new Error('lost'))),
      coordinator: coordinator({ hasPending: () => true }),
      logger,
    });

    expect(outcome).toEqual({ status: 'halted', reason: 'publication_still_pending' });
  });

  it('stops the batch when recovery itself fails', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-h',
      attempt: () => Promise.reject(new PublicationPendingError('pair-h', new Error('lost'))),
      coordinator: coordinator({ recover: () => Promise.reject(new Error('graph down')) }),
      logger,
    });

    expect(outcome).toEqual({ status: 'halted', reason: 'recovery_failed' });
  });

  it('stops after a success that left a publication pending behind it', async () => {
    const outcome = await applyMergeWithRecovery({
      operationId: 'pair-i',
      attempt: () => Promise.resolve({ merged: true }),
      coordinator: coordinator({ hasPending: () => true }),
      logger,
    });

    expect(outcome).toEqual({ status: 'halted', reason: 'publication_still_pending' });
  });
});
