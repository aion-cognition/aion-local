import { z } from 'zod';

import { PublicationOperation } from './operation.js';
import { buildEvidenceRevision } from './preconditions.js';
import type { PublicationHandler } from './types.js';
import {
  activateCoverageContract,
  readCurrentCoverageContract,
} from '../sqlite/coverage-contract.js';

const Payload = z.strictObject({
  expectedEpoch: z.string().min(1),
  capabilityRevision: z.number().int().positive(),
  fieldPolicyVersion: z.literal(1),
});
const Result = z.strictObject({
  capabilityRevision: z.number().int().positive(),
  fieldPolicyVersion: z.literal(1),
});

/** The compatibility audit owns the capability revision; a request cannot manufacture it. */
export const coverageActivationOperation = new PublicationOperation({
  kind: 'coverage_activation',
  effectKinds: ['coverage_control'],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(_context, payload) {
    return Promise.resolve({
      data: payload,
      expected: {
        coverageEpoch: payload.expectedEpoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [],
      effects: [
        { kind: 'coverage_control', detail: { fieldPolicyVersion: payload.fieldPolicyVersion } },
      ],
    });
  },
  check(context, data) {
    const coverage = readCurrentCoverageContract(context.db);
    const capability = context.db
      .prepare('SELECT activation_capability_revision AS revision FROM publication_control')
      .get() as { revision: number } | undefined;
    if (coverage?.epoch !== data.expectedEpoch) {
      return Promise.resolve({ status: 'deferred', reason: 'coverage_epoch_changed' });
    }
    if (capability?.revision !== data.capabilityRevision) {
      return Promise.resolve({ status: 'deferred', reason: 'compatibility_not_established' });
    }
    return Promise.resolve({ status: 'valid' });
  },
  applyGraph(_context, data) {
    return Promise.resolve({
      capabilityRevision: data.capabilityRevision,
      fieldPolicyVersion: data.fieldPolicyVersion,
    });
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    activateCoverageContract(context.db, {
      activatedAt: new Date(context.knownFrom),
      fieldPolicyVersion: data.fieldPolicyVersion,
      operationId: context.operationId,
    });
    return undefined;
  },
  discardSqlite() {
    return undefined;
  },
});

/** Consumers add their concrete, validated handlers here before their writers are enabled. */
export const PUBLICATION_HANDLERS: readonly PublicationHandler[] = [coverageActivationOperation];
