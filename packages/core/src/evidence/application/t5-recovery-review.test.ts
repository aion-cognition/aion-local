import { expect, it } from 'vitest';

import { applyMergeWithRecovery } from './merge-recovery.js';
import {
  PublicationInvariantError,
  PublicationPendingError,
} from '../../infrastructure/publication/errors.js';

it('propagates a pairing invariant raised while reconciling an uncertain commit', async () => {
  const failure = new PublicationInvariantError('pairing_mismatch');
  await expect(
    applyMergeWithRecovery({
      operationId: 'merge',
      attempt: async () => {
        throw new PublicationPendingError('merge', new Error('uncertain'));
      },
      coordinator: {
        hasPending: () => true,
        recover: async () => {
          throw failure;
        },
      },
      logger: { warn: () => undefined },
    }),
  ).rejects.toBe(failure);
});
