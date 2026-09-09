import { z } from 'zod';

import { admit } from './legacy-admission.js';
import { projectLegacyOwnership } from './legacy-ownership.js';
import {
  acknowledgeCensusSeal,
  acknowledgeMaterialization,
  censusCoverage,
  discardCensusSeal,
  discardMaterialization,
  endpointCensusScopes,
  isNodeEndpoint,
  pageUncountedEndpoints,
  prepareCensusSeal,
  prepareMaterialization,
  unaccountedCohortMembers,
} from './legacy-records.js';
import {
  acknowledgeLegacyStatements,
  discardLegacyStatements,
  legacyStatementScopes,
  LegacyStatementsSchema,
  planLegacyStatements,
  prepareLegacyStatements,
  type LegacyStatementPass,
} from './legacy-statements.js';
import { applySourceVerification, VerificationSchema } from './legacy-verification.js';
import { ownershipCensusEstablished } from '../../evidence/application/ownership.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { JsonValue, PublicationContext } from '../../infrastructure/publication/types.js';
import type { CommittedIncidence } from '../../infrastructure/sqlite/committed-evidence.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { planNodes, planScopes } from '../domain/legacy-materialization.js';

/**
 * The guarded legacy evidence producer.
 *
 * A source that predates the durable records has one witness for every mention, extraction and
 * correction it ever made: the edge in the graph. This operation turns those edges into records —
 * under the coordinator's guard, in one publication, with the graph enumeration taken inside the
 * same transaction that writes.
 *
 * It refuses to guess. An unproved archive, a walk that ran out of room, a relationship this
 * vocabulary cannot classify: each PINS the source and materializes nothing for it. A pinned
 * source stays resident, which is the fail-closed direction.
 *
 * Counting is a separate mode. One source is not a population, so a source pass moves the scope
 * counters and never establishes a census; the seal does that once the frozen cohort is walked.
 */
export const LEGACY_EFFECTS = {
  records: 'legacy_evidence_records',
  census: 'legacy_scope_census',
  statements: 'legacy_archive_statements',
} as const;

const SourcePayload = z.strictObject({
  mode: z.literal('source'),
  cohortId: z.string().min(1),
  sourceId: z.string().min(1),
  /** Charged before the walk. A page that fills it cannot certify anything. */
  relationLimit: z.number().int().positive(),
  /** The frozen archive bounds the verification is proved against. */
  archiveRowidLow: z.number().int().nonnegative(),
  archiveRowidHigh: z.number().int().nonnegative(),
  /** Re-prove a source that already reads verified, which is what a rebuild rests on. */
  reverify: z.boolean(),
});
const CensusPayload = z.strictObject({
  mode: z.literal('census'),
  cohortId: z.string().min(1),
  endpointLimit: z.number().int().positive(),
  /** The keyset cursor: the last endpoint the previous seal page counted. */
  after: z.string(),
});
const Payload = z.discriminatedUnion('mode', [SourcePayload, CensusPayload]);

const Link = z.strictObject({
  linkId: z.string().min(1),
  kind: z.string().min(1),
  qualifier: z.string().min(1),
  fromId: z.string().min(1),
  toId: z.string().min(1),
  relationId: z.string().min(1),
  relationType: z.string().min(1),
  scopeRole: z.string().min(1),
  incident: z.boolean(),
  closed: z.boolean(),
  clocks: z.record(z.string(), z.string()),
  recorded: z.record(z.string(), z.string()),
});
const Scope = z.strictObject({
  endpointId: z.string().min(1),
  relationClass: z.string().min(1),
});
const SourceData = SourcePayload.extend({
  gate: z.enum(['admitted', 'pinned']),
  reason: z.string(),
  /** The guarded re-verification's verdict, taken under this operation's own guard. */
  verification: VerificationSchema,
  links: z.array(Link),
  scopes: z.array(Scope),
  nodes: z.array(z.string()),
  /**
   * What the archive row states in its own payload, when the substrate has not accepted it yet.
   * Absent where the row carries none or the version already landed. A graph walk cannot find
   * these: a statement whose edge was never written survives only in the payload.
   */
  statements: LegacyStatementsSchema.optional(),
  observedAt: z.string().min(1),
});
const CensusData = CensusPayload.extend({
  endpoints: z.array(
    z.strictObject({
      endpointId: z.string().min(1),
      scopes: z.array(z.string().min(1)),
      node: z.boolean(),
    }),
  ),
  /**
   * The frozen cohort this count was taken over, stored with every scope it establishes. Absent
   * when no such cohort exists, which is what the check defers on.
   */
  coverage: z.optional(
    z.strictObject({
      cohortId: z.string().min(1),
      cohortDigest: z.string().min(1),
      graphCensusDigest: z.string().min(1),
      intakeWatermark: z.number().int().nonnegative(),
      archiveRowidLow: z.number().int().nonnegative(),
      archiveRowidHigh: z.number().int().nonnegative(),
      members: z.number().int().nonnegative(),
      verified: z.number().int().nonnegative(),
    }),
  ),
  observedAt: z.string().min(1),
});
const Data = z.discriminatedUnion('mode', [SourceData, CensusData]);
const Result = z.strictObject({
  mode: z.enum(['source', 'census']),
  materialized: z.number().int().nonnegative(),
  /** Links a newer acknowledged version already covers. A baseline never overwrites one. */
  preserved: z.number().int().nonnegative(),
  projected: z.number().int().nonnegative(),
  established: z.number().int().nonnegative(),
  /** The last endpoint a seal page counted, so the next page starts past it and always moves. */
  cursor: z.string(),
  pinned: z.boolean(),
  /** What the re-verification proved about the source, for the walk that records progress. */
  verified: z.boolean(),
  reason: z.string(),
});

type SourcePlanData = z.infer<typeof SourceData>;
type CensusPlanData = z.infer<typeof CensusData>;
type LegacyData = z.infer<typeof Data>;
type LegacyResult = z.infer<typeof Result>;

const EMPTY: Omit<LegacyResult, 'mode' | 'reason'> = {
  materialized: 0,
  preserved: 0,
  projected: 0,
  established: 0,
  cursor: '',
  pinned: false,
  verified: false,
};

function detail(value: JsonValue): JsonValue {
  return value;
}

/** The plan's own rows, in the shape ownership judges. They are durable and not yet committed. */
function plannedIncidence(data: SourcePlanData): readonly CommittedIncidence[] {
  return data.links
    .filter((entry) => entry.incident)
    .map((entry) => ({
      sourceId: entry.fromId,
      nodeId: entry.toId,
      role: entry.kind,
      currency: entry.closed ? ('closed' as const) : ('open' as const),
      linkId: entry.linkId,
      linkVersion: 1,
    }));
}

/** What each phase needs to prepare, acknowledge or discard the archive statements. */
function statementPass(data: SourcePlanData, operationId: string): LegacyStatementPass {
  return {
    sourceId: data.sourceId,
    operationId,
    acceptedAt: data.observedAt,
    statements: data.statements,
  };
}

export const legacyMaterializationPublication = new PublicationOperation({
  kind: 'legacy_materialization',
  effectKinds: [LEGACY_EFFECTS.records, LEGACY_EFFECTS.census, LEGACY_EFFECTS.statements],
  payload: Payload,
  data: Data,
  result: Result,
  async prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('legacy materialization cannot publish before the coverage registry exists');
    }
    const observedAt = context.now.toISOString();
    const expected = {
      coverageEpoch: coverage.epoch,
      evidence: buildEvidenceRevision([]),
      sources: [],
      heads: [],
    };
    if (payload.mode === 'census') {
      // Bound to the frozen record, not to a cohort id somebody typed. A cohort nobody froze
      // enumerates nothing here and is refused by the check below.
      const proof = censusCoverage(context.db, payload.cohortId);
      const endpoints =
        proof === undefined
          ? []
          : pageUncountedEndpoints(
              context.db,
              payload.cohortId,
              payload.after,
              payload.endpointLimit,
            ).map((endpointId) => ({
              endpointId,
              scopes: [...endpointCensusScopes(context.db, endpointId)],
              node: isNodeEndpoint(context.db, endpointId),
            }));
      const data: CensusPlanData = {
        ...payload,
        endpoints,
        ...(proof === undefined ? {} : { coverage: proof }),
        observedAt,
      };
      return {
        data,
        expected,
        scopes: endpoints.flatMap((endpoint) =>
          endpoint.scopes.map((scope) => ({
            kind: 'relation_scope' as const,
            id: endpoint.endpointId,
            scope,
          })),
        ),
        effects: [{ kind: LEGACY_EFFECTS.census, detail: { endpoints: endpoints.length } }],
      };
    }
    const admission = await admit(context.graph, context.db, payload, context.now);
    const links = [...admission.links];
    // Only for a source this pass admits. A pinned source proved nothing, and accepting what its
    // payload states would record statements against a source whose archive proof failed.
    const statements = admission.admitted
      ? await planLegacyStatements(context.graph, context.db, payload.sourceId, observedAt)
      : undefined;
    const data: SourcePlanData = {
      ...payload,
      gate: admission.admitted ? 'admitted' : 'pinned',
      reason: admission.reason,
      // Parsed rather than spread: the plan carried into the intent is the validated shape.
      verification: VerificationSchema.parse(admission.verification),
      links,
      scopes: [...planScopes(payload.sourceId, links)],
      nodes: [...planNodes(links)],
      ...(statements === undefined ? {} : { statements }),
      observedAt,
    };
    return {
      data,
      expected,
      scopes: [
        ...data.scopes.map((scope) => ({
          kind: 'relation_scope' as const,
          id: scope.endpointId,
          scope: scope.relationClass,
        })),
        ...legacyStatementScopes(payload.sourceId, statements),
      ],
      effects: [
        { kind: LEGACY_EFFECTS.records, detail: detail({ links: links.length }) },
        ...(statements === undefined
          ? []
          : [
              {
                kind: LEGACY_EFFECTS.statements,
                detail: detail({ targets: statements.targets.length }),
              },
            ]),
      ],
    };
  },
  check(context, data) {
    if (data.mode === 'census') {
      if (data.coverage === undefined) {
        return Promise.resolve({ status: 'deferred', reason: 'cohort_not_frozen' } as const);
      }
      // The seal's whole meaning is that nothing is left to count. A member the walk has not
      // reached, or one it pinned, is a page that has not accounted.
      const outstanding = unaccountedCohortMembers(context.db, data.cohortId);
      return Promise.resolve(
        outstanding === 0
          ? ({ status: 'valid' } as const)
          : ({ status: 'deferred', reason: 'cohort_not_fully_accounted' } as const),
      );
    }
    // The record may not exist yet: this operation is what writes it. What is refused is a plan
    // whose verdict names a different source than the payload does.
    if (data.verification.sourceId !== data.sourceId) {
      return Promise.resolve({ status: 'rejected', reason: 'verification_names_another_source' });
    }
    return Promise.resolve({ status: 'valid' } as const);
  },
  async applyGraph(context: PublicationContext, data: LegacyData): Promise<LegacyResult> {
    if (data.mode === 'census') {
      let projected = 0;
      for (const endpoint of data.endpoints) {
        if (
          endpoint.node &&
          (await projectLegacyOwnership(context, endpoint.endpointId, [], true))
        ) {
          projected += 1;
        }
      }
      const last = data.endpoints[data.endpoints.length - 1];
      return {
        ...EMPTY,
        mode: 'census',
        projected,
        established: data.endpoints.length,
        cursor: last?.endpointId ?? data.after,
        reason: 'every page of the cohort has accounted',
      };
    }
    if (data.gate === 'pinned') {
      return {
        ...EMPTY,
        mode: 'source',
        pinned: true,
        verified: data.verification.status === 'verified',
        reason: data.reason,
      };
    }
    const rows = plannedIncidence(data);
    let projected = 0;
    for (const nodeId of data.nodes) {
      const established = ownershipCensusEstablished(context.db, nodeId);
      if (await projectLegacyOwnership(context, nodeId, rows, established)) {
        projected += 1;
      }
    }
    return {
      ...EMPTY,
      mode: 'source',
      materialized: data.links.length,
      projected,
      verified: true,
      // What the pass concluded about the SOURCE. The classification reason only decides
      // anything when it pins, and then it is the reason the pin carries.
      reason: data.verification.reason,
    };
  },
  prepareSqlite(context, data) {
    if (data.mode === 'census') {
      prepareCensusSeal(context.db, {
        operationId: context.operationId,
        endpoints: data.endpoints,
        coverage: data.coverage ?? {},
        observedAt: new Date(data.observedAt),
      });
      return undefined;
    }
    // A pinned source prepares nothing. The pin itself is recorded by the caller that asked for
    // the pass, against the cohort's own progress row, so the reason survives the refusal.
    if (data.gate === 'pinned') {
      return undefined;
    }
    prepareMaterialization(context.db, {
      sourceId: data.sourceId,
      operationId: context.operationId,
      links: data.links,
      scopes: data.scopes,
      observedAt: new Date(data.observedAt),
    });
    prepareLegacyStatements(context.db, statementPass(data, context.operationId));
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    if (data.mode === 'census') {
      acknowledgeCensusSeal(
        context.db,
        {
          operationId: context.operationId,
          endpoints: data.endpoints,
          coverage: data.coverage ?? {},
          observedAt: new Date(data.observedAt),
        },
        context.knownFrom,
      );
      return undefined;
    }
    // The verdict is written here, in the transaction that acknowledges the operation that took
    // it. A pinned source gets its reason recorded and nothing else.
    applySourceVerification(context.db, data.verification, {
      operationId: context.operationId,
      knownFrom: new Date(context.knownFrom),
    });
    if (data.gate === 'pinned') {
      return undefined;
    }
    acknowledgeMaterialization(
      context.db,
      {
        sourceId: data.sourceId,
        operationId: context.operationId,
        scopes: data.scopes,
        observedAt: new Date(data.observedAt),
      },
      context.knownFrom,
      context.observedAckAt,
    );
    acknowledgeLegacyStatements(context.db, statementPass(data, context.operationId), context);
    return undefined;
  },
  discardSqlite(context, data) {
    if (data.mode === 'census') {
      discardCensusSeal(context.db, {
        operationId: context.operationId,
        endpoints: data.endpoints,
        coverage: data.coverage ?? {},
        observedAt: new Date(data.observedAt),
      });
      return undefined;
    }
    // The prepared links stay. They are durable, invisible and keyed on this operation, and a
    // later attempt writes its own version rather than inheriting this one.
    discardMaterialization(context.db, {
      sourceId: data.sourceId,
      operationId: context.operationId,
      scopes: data.scopes,
      observedAt: new Date(data.observedAt),
    });
    discardLegacyStatements(context.db, statementPass(data, context.operationId));
    return undefined;
  },
});
