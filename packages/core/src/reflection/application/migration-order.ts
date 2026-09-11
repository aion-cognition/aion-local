import { IsoTimestampSchema } from '@aion/protocol';
import { z } from 'zod';

import {
  sourceScopeDependencies,
  verifyEvidenceRevision,
} from '../../evidence/application/dependencies.js';
import { readSourceProjectionTime } from '../../infrastructure/graph/narrative-families.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readMigrationProgress } from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  readMigrationPolicy,
  rememberMigrationOrder,
} from '../../infrastructure/sqlite/migration-partition.js';
import {
  readSourceRecord,
  readSourceGraphClocksJson,
} from '../../infrastructure/sqlite/source-identity.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';

const Payload = z.strictObject({
  sourceId: z.string().min(1),
  cohortId: z.string().min(1),
  coverageEpoch: z.string().min(1),
});
const Data = Payload.extend({
  value: z.string().nullable(),
  basis: z.enum(['graph_tx_from', 'archive_acceptance']).nullable(),
  generation: z.number().int().nonnegative(),
});
const Result = z.strictObject({ recorded: z.boolean(), gap: z.string().nullable() });

function recordedInstant(value: unknown): string | undefined {
  const result = IsoTimestampSchema.safeParse(value);
  return result.success ? new Date(result.data).toISOString() : undefined;
}

/** Source verification stays with its existing producer; this writer records only the ordering proof. */
export const migrationOrderPublication = new PublicationOperation({
  kind: 'migration_order',
  effectKinds: ['migration_order_recorded'],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    const record = readSourceRecord(context.db, payload.sourceId);
    const generation = readSourceResidency(context.db, payload.sourceId)?.projectionGeneration ?? 0;
    const saved = readSourceGraphClocksJson(context.db, payload.sourceId);
    const original = saved === undefined ? undefined : (JSON.parse(saved) as { tx_from?: unknown });
    const graph =
      recordedInstant(original?.tx_from) ??
      (generation === 0
        ? recordedInstant(await readSourceProjectionTime(context.graph, payload.sourceId))
        : undefined);
    const archived = recordedInstant(record?.archivedAt);
    let basis: 'graph_tx_from' | 'archive_acceptance' | null = null;
    if (graph !== undefined) {
      basis = 'graph_tx_from';
    } else if (archived !== undefined) {
      basis = 'archive_acceptance';
    }
    return {
      data: {
        ...payload,
        generation,
        value: graph ?? archived ?? null,
        basis,
      },
      expected: {
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision(
          sourceScopeDependencies(context.db, payload.sourceId).filter(
            (entry) => entry.scope === 'source.content' || entry.scope === 'source.parts',
          ),
        ),
        sources: [],
        heads: [],
      },
      scopes: [{ kind: 'source', id: payload.sourceId, scope: 'migration.capture_order' }],
      effects: [
        {
          kind: 'migration_order_recorded',
          detail: { sourceId: payload.sourceId, cohortId: payload.cohortId },
        },
      ],
    };
  },
  check(context, data, expected) {
    if (
      readMigrationPolicy(context.db, data.cohortId) === undefined ||
      readMigrationProgress(context.db, data.cohortId, data.sourceId)?.status !== 'verified' ||
      readSourceRecord(context.db, data.sourceId)?.verificationStatus !== 'verified'
    ) {
      return Promise.resolve({
        status: 'deferred',
        reason: 'migration_source_unverified',
      } as const);
    }
    if (
      (readSourceResidency(context.db, data.sourceId)?.projectionGeneration ?? 0) !==
        data.generation ||
      verifyEvidenceRevision(context.db, expected.evidence).status !== 'current'
    ) {
      return Promise.resolve({
        status: 'deferred',
        reason: 'migration_order_evidence_changed',
      } as const);
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  applyGraph(_context, data) {
    return Promise.resolve({
      recorded: data.value !== null,
      gap: data.value === null ? 'capture_order_unproved' : null,
    });
  },
  prepareSqlite() {
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    rememberMigrationOrder(context.db, {
      sourceId: data.sourceId,
      cohortId: data.cohortId,
      ...(data.value === null || data.basis === null
        ? { gap: 'capture_order_unproved' }
        : { value: data.value, basis: data.basis }),
    });
    return undefined;
  },
  discardSqlite() {
    return undefined;
  },
});
