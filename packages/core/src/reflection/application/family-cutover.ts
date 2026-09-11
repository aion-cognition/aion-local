import { z } from 'zod';

import {
  acknowledgeFamilyAdvance,
  discardFamilyAdvance,
  FAMILY_SELECTION_SCOPE,
  prepareFamilyAdvance,
} from './family-fence.js';
import {
  hasNarrativeSession,
  hasLegacyNarrativeHistory,
  readLegacyHeads,
  readLegacyNarrativeInventory,
  readNarrativeFamilyIdentities,
  tagLegacyNarratives,
} from '../../infrastructure/graph/narrative-families.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import {
  acknowledgeFamilySelection,
  readFamilySelection,
} from '../../infrastructure/sqlite/family-selection.js';
import {
  readLegacyNarrative,
  recordLegacyNarrative,
  retireLegacyNarrative,
} from '../../infrastructure/sqlite/legacy-narratives.js';
import {
  MIGRATION_SESSION_LIMIT,
  readCutoverPartition,
} from '../../infrastructure/sqlite/migration-session.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import { coverageKey } from '../domain/narrative.js';

export const LEGACY_HEAD_LIMIT = 128;
export const FAMILY_EFFECT = 'session_narrative_family';

const Payload = z.strictObject({
  action: z.enum(['initialize', 'inventory', 'cutover']),
  sessionId: z.string().min(1),
  coverageEpoch: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  cohortId: z.string().optional(),
  partitionDigest: z.string().optional(),
  expectedHeads: z.array(z.string().min(1)).max(LEGACY_HEAD_LIMIT).optional(),
  narrativeId: z.string().optional(),
});
const Inventory = z.strictObject({
  nodeId: z.string().min(1),
  verified: z.boolean(),
  proof: z.string(),
});
const Data = Payload.extend({
  family: z.enum(['legacy_session_overview', 'chunk']),
  heads: z.array(z.string()),
  chunkIds: z.array(z.string()),
  inventory: Inventory.nullable(),
  refusal: z.string().nullable(),
  observedAt: z.string().min(1),
});
const Result = z.strictObject({
  family: z.enum(['legacy_session_overview', 'chunk']),
  marked: z.number().int().nonnegative(),
});

/** Family changes and their graph markers share one receipt and one canonical ACK. */
export const familyCutoverPublication = new PublicationOperation({
  kind: 'family_cutover',
  effectKinds: [FAMILY_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    if (readCurrentCoverageContract(context.db) === undefined) {
      throw new Error('family publication requires a coverage contract');
    }
    const selected = readFamilySelection(context.db, payload.sessionId);
    let refusal: string | null = (await hasNarrativeSession(context.graph, payload.sessionId))
      ? null
      : 'session_missing';
    let heads: readonly string[] = [];
    let chunkIds: readonly string[] = [];
    let inventory: z.infer<typeof Inventory> | null = null;
    let family = selected?.family ?? 'chunk';
    if (payload.action === 'initialize') {
      family = (await hasLegacyNarrativeHistory(context.graph, payload.sessionId))
        ? 'legacy_session_overview'
        : 'chunk';
    } else if (payload.action === 'cutover') {
      const partition = readCutoverPartition(context.db, payload.cohortId ?? '', payload.sessionId);
      heads = await readLegacyHeads(context.graph, payload.sessionId, LEGACY_HEAD_LIMIT + 1);
      refusal ??= partition.reason ?? null;
      if (
        partition.digest !== payload.partitionDigest ||
        JSON.stringify(heads) !== JSON.stringify([...(payload.expectedHeads ?? [])].sort())
      ) {
        refusal ??= 'cutover_inputs_moved';
      }
      ({ chunkIds } = partition);
      family = 'chunk';
    } else {
      const record = await readLegacyNarrativeInventory(context.graph, {
        nodeId: payload.narrativeId ?? '',
        sessionId: payload.sessionId,
        memberLimit: MIGRATION_SESSION_LIMIT + 1,
      });
      if (record === undefined) {
        refusal = 'legacy_narrative_missing';
      } else {
        const identities = record.sourceIds.every(
          (id) => readSourceRecord(context.db, id)?.verificationStatus === 'verified',
        );
        const present = new Set(await presentNodeIds(context.graph, record.citations));
        const citations = record.citations.every(
          (id) =>
            present.has(id) || readSourceRecord(context.db, id)?.verificationStatus === 'verified',
        );
        const verified =
          record.sourceIds.length <= MIGRATION_SESSION_LIMIT &&
          record.citationCount === record.citations.length &&
          record.citations.length <= MIGRATION_SESSION_LIMIT &&
          identities &&
          citations &&
          record.coverageCount === record.sourceIds.length &&
          record.coverageKey === coverageKey(record.sourceIds);
        inventory = {
          nodeId: record.nodeId,
          verified,
          proof: JSON.stringify({ ...record, identities, citations }),
        };
      }
    }
    if (heads.length > LEGACY_HEAD_LIMIT) {
      refusal = 'legacy_heads_bound';
    }
    const identities = await readNarrativeFamilyIdentities(
      context.graph,
      payload.action === 'inventory' ? [payload.narrativeId ?? ''] : heads,
    );
    if (
      identities.some(
        (identity) =>
          identity.sessionId !== payload.sessionId || identity.family !== 'legacy_session_overview',
      )
    ) {
      refusal = 'legacy_session_ambiguous';
    }
    const data: z.infer<typeof Data> = {
      ...payload,
      family,
      heads: [...heads],
      chunkIds: [...chunkIds],
      inventory,
      refusal,
      observedAt: context.now.toISOString(),
    };
    return {
      data,
      expected: {
        coverageEpoch: payload.coverageEpoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [{ kind: 'relation_scope', id: payload.sessionId, scope: FAMILY_SELECTION_SCOPE }],
      effects: [
        { kind: FAMILY_EFFECT, detail: { sessionId: payload.sessionId, action: payload.action } },
      ],
    };
  },
  async check(context, data) {
    const selected = readFamilySelection(context.db, data.sessionId);
    if ((selected?.version ?? 0) !== data.expectedVersion) {
      return { status: 'deferred', reason: 'family_selection_moved' };
    }
    if (data.refusal !== null) {
      return { status: 'deferred', reason: data.refusal };
    }
    if (data.action === 'initialize') {
      if (selected !== undefined) {
        return { status: 'deferred', reason: 'family_already_initialized' };
      }
    } else if (selected === undefined) {
      return { status: 'deferred', reason: 'family_not_initialized' };
    }
    if (data.action === 'cutover') {
      if (selected?.family !== 'legacy_session_overview') {
        return { status: 'deferred', reason: 'family_already_selected' };
      }
      const partition = readCutoverPartition(context.db, data.cohortId ?? '', data.sessionId);
      if (partition.reason !== undefined || partition.digest !== data.partitionDigest) {
        return { status: 'deferred', reason: partition.reason ?? 'partition_moved' };
      }
    }
    if (data.action === 'cutover') {
      const heads = await readLegacyHeads(context.graph, data.sessionId, LEGACY_HEAD_LIMIT + 1);
      if (JSON.stringify(heads) !== JSON.stringify(data.heads)) {
        return { status: 'deferred', reason: 'legacy_head_moved' };
      }
    }
    if (data.action === 'initialize') {
      const family = (await hasLegacyNarrativeHistory(context.graph, data.sessionId))
        ? 'legacy_session_overview'
        : 'chunk';
      if (family !== data.family) {
        return { status: 'deferred', reason: 'legacy_family_presence_changed' };
      }
    }
    return { status: 'valid' };
  },
  async applyGraph(context, data) {
    let ids = data.heads;
    if (data.action === 'inventory') {
      ids = data.inventory === null ? [] : [data.inventory.nodeId];
    }
    await tagLegacyNarratives(
      context.graph,
      data.sessionId,
      ids,
      data.action === 'cutover' ? context.operationId : undefined,
    );
    return { family: data.family, marked: ids.length };
  },
  prepareSqlite(context, data) {
    prepareFamilyAdvance(
      context.db,
      data.sessionId,
      context.operationId,
      new Date(data.observedAt),
    );
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    if (data.action === 'inventory' && data.inventory !== null) {
      recordLegacyNarrative(context.db, {
        narrativeId: data.inventory.nodeId,
        sessionId: data.sessionId,
        verificationStatus: data.inventory.verified ? 'verified' : 'pinned',
        verificationJson: data.inventory.proof,
        createdAt: new Date(context.knownFrom),
      });
    } else {
      for (const narrativeId of data.heads) {
        if (readLegacyNarrative(context.db, narrativeId) === undefined) {
          recordLegacyNarrative(context.db, {
            narrativeId,
            sessionId: data.sessionId,
            verificationStatus: 'pinned',
            verificationJson: JSON.stringify({ reason: 'legacy_coverage_not_inventoried' }),
            createdAt: new Date(context.knownFrom),
          });
        }
        if (data.action === 'cutover') {
          retireLegacyNarrative(context.db, {
            narrativeId,
            sessionId: data.sessionId,
            operationId: context.operationId,
            knownFrom: context.knownFrom,
            chunkIds: data.chunkIds,
            cohortId: data.cohortId ?? '',
          });
        }
      }
      acknowledgeFamilySelection(context.db, {
        sessionId: data.sessionId,
        expectedVersion: data.expectedVersion,
        family: data.family,
        operationId: context.operationId,
      });
    }
    acknowledgeFamilyAdvance(context.db, data.sessionId, context.operationId, context.knownFrom);
    return undefined;
  },
  discardSqlite(context, data) {
    discardFamilyAdvance(context.db, data.sessionId, context.operationId);
    return undefined;
  },
});
