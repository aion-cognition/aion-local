import { reflectionBoundsBreaches } from '@aion/protocol';
import { z } from 'zod';

import { projectEpisodeInTransaction } from './experience-store.js';
import { sourcePartsOf } from './source-manifest.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { PublicationContext } from '../../infrastructure/publication/types.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { getExperienceById } from '../../infrastructure/sqlite/experience-archive.js';
import {
  readSourcePartTurnIds,
  readSourceParts,
  readSourceRecord,
  type SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import {
  RAW_REBUILD_EFFECT,
  readSourceResidency,
  recordEvidenceAcknowledgment,
  settleSourceResidency,
  transitionSourceResidency,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { prepareEpisode, type PreparedEpisode, type ReflectionContent } from '../domain/content.js';

/**
 * Putting an evicted source's raw projection back, under the ids it always had.
 *
 * It is guarded and explicit because ordinary replay must never do it: a projection invented to
 * satisfy a lookup is the implicit rehydration the residency rules forbid. This validates the
 * original ids before it writes anything and refuses an id somebody else now occupies, since
 * writing over one would silently replace another source's node with this one's content.
 *
 * The reconstruction is raw and nothing more. It re-runs no extraction, appends no feedback and
 * mints no witness: its acknowledgment lives in its own effect namespace, so completing it says
 * nothing about the semantic processing the source owes. Requested re-derivation is a separate
 * opt-in that carries its own processing generation.
 */
export const REBUILD_EFFECT = 'raw_projection';

const Payload = z.strictObject({
  sourceId: z.string().min(1),
  observedAt: z.string().min(1),
});

const Data = Payload.extend({
  sessionId: z.string().min(1),
  archiveId: z.string().min(1),
  turnIds: z.array(z.string().min(1)),
  /** The SELECTED occurrence's own world time, not the canonical raw row's. */
  occurredAt: z.string().min(1),
  payloadJson: z.string().min(1),
  projectionGeneration: z.number().int().positive(),
  /**
   * What the recorded proof said about these bytes, checked again before anything is written.
   * A non-null archive pointer is a claim, not evidence: the row it names can have moved under
   * it, and reconstructing from bytes that no longer hash to the verified digest would republish
   * different content under the original ids.
   */
  proof: z.enum(['verified', 'content_changed', 'parts_changed', 'incomplete']),
  /**
   * Which new-request bounds the archived payload exceeds. A rebuild reports the pin and still
   * reconstructs: the caps gate new requests, and applying them here would corrupt a record the
   * substrate already accepted.
   */
  pinnedOversized: z.array(z.string()),
});

const Result = z.strictObject({
  sourceId: z.string().min(1),
  turnIds: z.array(z.string().min(1)),
  pinnedOversized: z.array(z.string()),
});

/**
 * Whether the bytes and the parts still match what the occurrence was verified against.
 *
 * Every field of the proof has to be there: an occurrence that never carried one cannot have it
 * confirmed, and treating absence as agreement is how a rebuild republishes content nobody
 * verified. The parts are compared on kind, ordinal, hash, role and original id, because those
 * are what the reconstruction writes back under.
 */
function verifyRebuildProof(
  db: SqliteHandle,
  record: SourceRecord,
  archived: ReflectionContent,
  prepared: PreparedEpisode,
): z.infer<typeof Data>['proof'] {
  if (
    record.verifiedContentDigest === null ||
    record.identityHash === null ||
    record.archiveSchemaVersion === null
  ) {
    return 'incomplete';
  }
  if (prepared.contentHash !== record.verifiedContentDigest) {
    return 'content_changed';
  }
  const recorded = readSourceParts(db, record.sourceId);
  const expected = sourcePartsOf(prepared, archived, readSourcePartTurnIds(db, record.sourceId));
  if (recorded.length !== expected.length) {
    return 'parts_changed';
  }
  const held = new Map(recorded.map((part) => [`${part.partKind}:${String(part.ordinal)}`, part]));
  for (const part of expected) {
    const known = held.get(`${part.partKind}:${String(part.ordinal)}`);
    if (
      known?.contentHash !== part.contentHash ||
      (known.role ?? undefined) !== part.role ||
      (part.turnId !== undefined && known.turnId !== part.turnId)
    ) {
      return 'parts_changed';
    }
  }
  return 'verified';
}

type RebuildData = z.infer<typeof Data>;

function content(data: RebuildData): ReflectionContent {
  return JSON.parse(data.payloadJson) as ReflectionContent;
}

/**
 * The raw content, with the stated references left out. They were never in the hash, and a
 * rebuild reconstructs the record rather than re-stating what somebody asserted about it.
 */
function archivedContent(payload: ReflectionContent): ReflectionContent {
  const { provenance, ...rest } = payload;
  void provenance;
  return rest;
}

/** Ids the graph already holds. An evicted source has none, so any hit is an occupant. */
async function occupants(
  context: PublicationContext,
  ids: readonly string[],
): Promise<readonly string[]> {
  return context.graph.run(
    'UNWIND $ids AS id MATCH (n:AionNode { id: id }) RETURN n.id AS id',
    { ids: [...ids] },
    (row) => row.id as string,
  );
}

export const projectionRebuildPublication = new PublicationOperation({
  kind: 'projection_rebuild',
  effectKinds: [REBUILD_EFFECT],
  payload: Payload,
  data: Data,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('rebuild cannot publish before the coverage registry exists');
    }
    const record = readSourceRecord(context.db, payload.sourceId);
    if (record?.canonicalArchiveId == null) {
      throw new Error(`source ${payload.sourceId} has no verified archive row to rebuild from`);
    }
    const row = getExperienceById(context.db, record.canonicalArchiveId);
    if (row === undefined) {
      throw new Error(`archive row ${record.canonicalArchiveId} is missing`);
    }
    const archived = archivedContent(row.payload);
    const turnIds = readSourcePartTurnIds(context.db, payload.sourceId);
    // The occurrence's own recorded world time, not the canonical row's: a replacement sharing a
    // forgotten predecessor's bytes has its own clock, and reconstructing under the predecessor's
    // would date it to a conversation it was not part of.
    const prepared = prepareEpisode(archived, new Date(record.occurredAt));
    const proof =
      turnIds.length === prepared.turns.length
        ? verifyRebuildProof(context.db, record, archived, prepared)
        : 'parts_changed';
    // The attempt takes the generation, not the outcome: a rebuild that fails leaves its number
    // spent, so a retry writes under one nothing else has used. The number is chosen here and
    // taken in the durable prepare, which is the only place this operation writes.
    const projectionGeneration =
      (readSourceResidency(context.db, payload.sourceId)?.projectionGeneration ?? 0) + 1;
    const data: RebuildData = {
      ...payload,
      sessionId: record.sessionId,
      archiveId: record.canonicalArchiveId,
      turnIds: [...turnIds],
      occurredAt: record.occurredAt,
      payloadJson: JSON.stringify(archived),
      projectionGeneration,
      proof,
      pinnedOversized: reflectionBoundsBreaches(archived).map((breach) => breach.bound),
    };
    return Promise.resolve({
      data,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([
          {
            kind: 'source',
            id: payload.sourceId,
            scope: 'sqlite:source_residency',
            version: String(projectionGeneration),
          },
        ]),
        sources: [],
        heads: [],
      },
      scopes: [{ kind: 'source', id: payload.sourceId, scope: 'sqlite:source_residency' }],
      effects: [
        {
          kind: REBUILD_EFFECT,
          detail: { sourceId: payload.sourceId, generation: projectionGeneration },
        },
      ],
    });
  },
  async check(context, data) {
    if (data.proof !== 'verified') {
      return { status: 'rejected', reason: `rebuild_proof_${data.proof}` } as const;
    }
    // Rechecked here and not only at planning: recovery replays this plan, and the bytes it
    // reconstructs from have to still be the bytes the occurrence was verified against.
    const record = readSourceRecord(context.db, data.sourceId);
    const row =
      record?.canonicalArchiveId == null
        ? undefined
        : getExperienceById(context.db, record.canonicalArchiveId);
    if (record === undefined || row === undefined) {
      return { status: 'rejected', reason: 'rebuild_proof_incomplete' } as const;
    }
    const archived = archivedContent(row.payload);
    const current = verifyRebuildProof(
      context.db,
      record,
      archived,
      prepareEpisode(archived, new Date(record.occurredAt)),
    );
    if (current !== 'verified') {
      return { status: 'rejected', reason: `rebuild_proof_${current}` } as const;
    }
    const residency = readSourceResidency(context.db, data.sourceId);
    // A source with no row of its own never left, so it is resident and there is nothing to
    // put back. Deciding that before the occupant read keeps the refusal honest about which
    // rule was broken.
    if ((residency?.state ?? 'resident') === 'resident') {
      return { status: 'rejected', reason: 'source_not_evicted' } as const;
    }
    const held = residency?.projectionGeneration ?? 0;
    // Either this attempt has not taken its generation yet, or it took it and still owns it.
    const owns =
      held === data.projectionGeneration - 1 ||
      (held === data.projectionGeneration && residency?.activeOperationId === context.operationId);
    if (!owns) {
      return { status: 'deferred', reason: 'rebuild_superseded' } as const;
    }
    const occupied = await occupants(context, [data.sourceId, ...data.turnIds]);
    if (occupied.length > 0) {
      return { status: 'rejected', reason: 'original_ids_occupied' } as const;
    }
    return { status: 'valid' } as const;
  },
  async applyGraph(context: PublicationContext, data: RebuildData) {
    // World time comes off the archived record and transaction time is today's: the substrate
    // learned this again now, and stamping the write into the past would record a write nobody
    // made. The original logical clocks stay in the evidence records untouched.
    await projectEpisodeInTransaction(context.graph, {
      prepared: prepareEpisode(content(data), new Date(data.occurredAt)),
      sessionId: data.sessionId,
      origin: undefined,
      now: context.now,
      identity: { episodeId: data.sourceId, turnIds: data.turnIds },
    });
    return {
      sourceId: data.sourceId,
      turnIds: [...data.turnIds],
      pinnedOversized: [...data.pinnedOversized],
    };
  },
  prepareSqlite(context, data) {
    const taken = transitionSourceResidency(context.db, {
      sourceId: data.sourceId,
      state: 'evicted',
      operationId: context.operationId,
      transitionedAt: new Date(data.observedAt),
    });
    if (taken !== data.projectionGeneration) {
      throw new Error(
        `rebuild of ${data.sourceId} planned generation ${String(data.projectionGeneration)} and took ${String(taken)}`,
      );
    }
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    const settled = settleSourceResidency(context.db, {
      sourceId: data.sourceId,
      state: 'resident',
      projectionGeneration: data.projectionGeneration,
      operationId: context.operationId,
      transitionedAt: new Date(context.knownFrom),
      rebuildAckAt: new Date(context.observedAckAt),
    });
    if (!settled) {
      throw new Error(`rebuild of ${data.sourceId} was superseded before its acknowledgment`);
    }
    // Its own namespace: raw reconstruction completing says nothing about semantic processing.
    recordEvidenceAcknowledgment(context.db, {
      sourceId: data.sourceId,
      referenceVersion: 1,
      effectKind: RAW_REBUILD_EFFECT,
      state: 'completed',
      completedAt: new Date(context.observedAckAt),
      detail: { projectionGeneration: data.projectionGeneration },
    });
    return undefined;
  },
  discardSqlite() {
    // The spent generation stays spent and the source stays evicted. Nothing accepted is lost.
    return undefined;
  },
});
