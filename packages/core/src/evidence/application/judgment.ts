import type { Driver } from 'neo4j-driver';

import { EvidenceDependencies, readRelationScope, type RevisionCheck } from './dependencies.js';
import { resolveSourceEvidence, type SourceEvidence } from './sources.js';
import { readClaimSubjects } from './subjects.js';
import type { ClaimSubject } from '../../infrastructure/graph/subject-family.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { idAddress, type EvidenceAddress } from '../domain/address.js';
import {
  renderableUnits,
  utf16CodeUnits,
  RequestBudget,
  type JudgeRoute,
} from '../domain/budget.js';
import type { EvidenceIssue, EvidenceUse } from '../domain/result.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * The evidence a destructive judgment is allowed to run on, assembled before any model is asked.
 *
 * Each side's own originating source is reserved first and whole: a judge shown a clipped
 * statement and six recent episodes decided a false correction once, and the fix is that the
 * exact source either fits or nobody is asked. Optional context is filled only with what is left
 * over, so an omitted gloss never costs a required unit.
 *
 * Suppression is the one outcome that is not a gap. A required source proved suppressed returns
 * an abstention: no assembled input, no provider call, and the obligation stays where it was.
 * That is supported non-disclosure rather than missing evidence, and turning it into either a
 * history gap or a complete answer would misreport what the substrate did.
 */

export type JudgmentSideRequest = {
  readonly nodeId: string;
  /** The statement as the caller states it, which is what the judge is asked about. */
  readonly statement: string;
};

export type JudgmentPair = {
  readonly route: JudgeRoute;
  /** The prompt and output units this route reserves before evidence is rendered. */
  readonly reservedUnits: number;
  readonly use: Extract<EvidenceUse, 'claim_judgment' | 'entity_judgment'>;
  readonly sides: readonly [JudgmentSideRequest, JudgmentSideRequest];
};

export type JudgmentSide = {
  readonly nodeId: string;
  readonly statement: string;
  readonly requiredSources: readonly SourceEvidence[];
  readonly optionalSubjects: readonly ClaimSubject[];
  readonly renderedUnits: number;
};

export type JudgmentAssembly =
  | {
      readonly status: 'assembled';
      readonly sides: readonly [JudgmentSide, JudgmentSide];
      readonly revision: EvidenceRevision;
      /** Optional context left out, disclosed without lowering what the required units say. */
      readonly omitted: readonly EvidenceIssue[];
    }
  | {
      readonly status: 'abstained';
      readonly reason: 'required_source_suppressed';
      readonly addresses: readonly EvidenceAddress[];
      readonly revision: EvidenceRevision;
    }
  | {
      readonly status: 'incomplete';
      readonly reasons: readonly EvidenceIssue[];
      readonly revision: EvidenceRevision;
    };

export type JudgmentDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
};

/**
 * The seam a judgment path holds. It carries the checked context it was built with, so a stage
 * never constructs a temporal vantage of its own to read evidence under.
 */
export type JudgmentEvidence = {
  assemble(pair: JudgmentPair): Promise<JudgmentAssembly>;
  /** Whether the evidence a returned judgment was made on still stands, before it is applied. */
  confirm(revision: EvidenceRevision): RevisionCheck;
};

type RequiredSources =
  | { readonly status: 'named'; readonly sourceIds: readonly string[] }
  | { readonly status: 'unverified' };

/**
 * Every source occurrence the claim was extracted from. A folded claim reserves all of them:
 * picking one edge would reserve the wrong witness whenever the fold is what the judgment turns
 * on. An unproved empty set is not a claim without sources.
 */
function requiredSourcesOf(db: SqliteHandle, nodeId: string): RequiredSources {
  const rows = committedIncidenceForNode(db, nodeId, 'extraction');
  const scope = readRelationScope(db, {
    kind: 'node',
    endpointId: nodeId,
    scope: durableRoleScope('extraction', 'out'),
    empty: rows.length === 0,
  });
  if (scope.status !== 'verified' || rows.length === 0) {
    return { status: 'unverified' };
  }
  return { status: 'named', sourceIds: [...new Set(rows.map((row) => row.sourceId))] };
}

type SideReading = {
  readonly side?: JudgmentSide;
  readonly issues: readonly EvidenceIssue[];
  readonly suppressed: readonly EvidenceAddress[];
  readonly omitted: readonly EvidenceIssue[];
};

async function readSide(
  deps: JudgmentDeps,
  request: JudgmentSideRequest,
  pair: JudgmentPair,
  context: CheckedReadContext,
  budget: RequestBudget,
  dependencies: EvidenceDependencies,
): Promise<SideReading> {
  const address = idAddress(request.nodeId);
  const required = requiredSourcesOf(deps.db, request.nodeId);
  if (required.status === 'unverified') {
    return {
      issues: [
        { address, field: 'source_content', reason: 'required_scope_missing', required: true },
      ],
      suppressed: [],
      omitted: [],
    };
  }

  const sources: SourceEvidence[] = [];
  const issues: EvidenceIssue[] = [];
  const suppressed: EvidenceAddress[] = [];
  for (const sourceId of required.sourceIds) {
    const resolution = resolveSourceEvidence(deps.db, idAddress(sourceId), {
      use: pair.use,
      context,
      budget,
      required: true,
    });
    dependencies.addAll(resolution.dependencies);
    for (const issue of resolution.issues) {
      if (issue.reason === 'suppressed_source') {
        suppressed.push(issue.address);
      } else {
        issues.push(issue);
      }
    }
    if (resolution.value !== undefined) {
      sources.push(resolution.value);
    } else if (resolution.issues.length === 0) {
      issues.push({
        address: idAddress(sourceId),
        field: 'source_content',
        reason: 'not_found',
        required: true,
      });
    }
  }

  if (suppressed.length > 0 || issues.length > 0) {
    return { issues, suppressed, omitted: [] };
  }

  const subjects = await readClaimSubjects(deps, {
    claimIds: [request.nodeId],
    context,
    budget,
  });
  dependencies.addAll(subjects.dependencies);
  const optional = subjects.results.values().next().value?.value ?? [];
  return {
    side: {
      nodeId: request.nodeId,
      statement: request.statement,
      requiredSources: sources,
      optionalSubjects: optional,
      renderedUnits:
        utf16CodeUnits(request.statement) +
        sources.reduce((total, source) => total + source.rawUtf16CodeUnits, 0),
    },
    issues: [],
    suppressed: [],
    // Subject glosses are context. A gap in them is disclosed and never lowers what the required
    // units say, which is the whole difference between omitting context and missing evidence.
    omitted: subjects.issues.map((issue) => ({ ...issue, required: false })),
  };
}

/**
 * Both sides of one pair, or the reason no judge may be asked about it.
 *
 * The allowance is checked against what the two sides actually render to, after the route's own
 * fixed reserve. A pair that does not fit is incomplete before either pass runs: paging the
 * required units and calling the result whole is the failure this exists to prevent.
 */
export async function assembleJudgmentEvidence(
  deps: JudgmentDeps,
  pair: JudgmentPair,
  context: CheckedReadContext,
  budget: RequestBudget = new RequestBudget(),
): Promise<JudgmentAssembly> {
  const dependencies = new EvidenceDependencies();
  const first = await readSide(deps, pair.sides[0], pair, context, budget, dependencies);
  const second = await readSide(deps, pair.sides[1], pair, context, budget, dependencies);
  const readings = [first, second];
  const revision = dependencies.revision();
  const suppressed = readings.flatMap((reading) => reading.suppressed);
  if (suppressed.length > 0) {
    return {
      status: 'abstained',
      reason: 'required_source_suppressed',
      addresses: suppressed,
      revision,
    };
  }
  const issues = readings.flatMap((reading) => reading.issues);
  if (issues.length > 0) {
    return { status: 'incomplete', reasons: issues, revision };
  }

  if (first.side === undefined || second.side === undefined) {
    return {
      status: 'incomplete',
      reasons: [
        {
          address: idAddress(pair.sides[0].nodeId),
          field: 'source_content',
          reason: 'required_scope_missing',
          required: true,
        },
      ],
      revision,
    };
  }

  const sides: readonly [JudgmentSide, JudgmentSide] = [first.side, second.side];
  const rendered = sides[0].renderedUnits + sides[1].renderedUnits;
  if (rendered > renderableUnits({ route: pair.route, reservedUnits: pair.reservedUnits })) {
    return {
      status: 'incomplete',
      reasons: sides.map((side) => ({
        address: idAddress(side.nodeId),
        field: 'source_content' as const,
        reason: 'budget_limit' as const,
        required: true,
      })),
      revision,
    };
  }
  return {
    status: 'assembled',
    sides,
    revision,
    omitted: readings.flatMap((reading) => reading.omitted),
  };
}
