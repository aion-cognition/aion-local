import type { Driver } from 'neo4j-driver';

import { EvidenceDependencies, type RevisionCheck } from './dependencies.js';
import { readRequired } from './judgment-required.js';
import type { SourceEvidence } from './sources.js';
import { readClaimSubjects } from './subjects.js';
import type { ClaimSubject } from '../../infrastructure/graph/subject-family.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { idAddress, type EvidenceAddress } from '../domain/address.js';
import {
  renderableUnits,
  utf16CodeUnits,
  RENDERED_SIDE_OVERHEAD,
  RequestBudget,
  type JudgeRoute,
} from '../domain/budget.js';
import type { EvidenceIssue, EvidenceUse } from '../domain/result.js';

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
  /** The evidence block the judge is shown, which is the text admitted against the allowance. */
  readonly renderedContext: string;
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
 * What a withheld judgment leaves behind.
 *
 * A proved suppression is blocked: nobody can decide it until the source comes back, and the
 * obligation is held rather than retried on a cadence. Incomplete evidence is retryable: a
 * backfill or a settled publication makes the same pair decidable. Both carry the addresses and
 * the dependency revision, because a durable block that cannot name its evidence is not one.
 */
export type WithheldJudgment = {
  readonly kind: 'blocked' | 'retryable';
  readonly reason: string;
  readonly addresses: readonly EvidenceAddress[];
  readonly revision: EvidenceRevision;
};

/**
 * One outstanding judgment, in the shape a work owner can act on.
 *
 * A counter says how many pairs were withheld; it does not say which, why, or against what
 * evidence, and none of those can be recovered from a number. Blocked work needs the addresses
 * an unforget would revalidate it from; retryable work needs the revision a backfill would move.
 */
export type WithheldWork = {
  readonly nodeIds: readonly string[];
  readonly disposition: 'blocked' | 'retryable';
  readonly reason: string;
  readonly addresses: readonly EvidenceAddress[];
  readonly revision: EvidenceRevision;
};

/** The work one withheld pair leaves behind, named by the nodes it was about. */
export function withheldWorkFor(
  nodeIds: readonly string[],
  withheld: WithheldJudgment,
): WithheldWork {
  return {
    nodeIds: [...nodeIds],
    disposition: withheld.kind,
    reason: withheld.reason,
    addresses: withheld.addresses,
    revision: withheld.revision,
  };
}

export type JudgmentEvidenceOutcome =
  /** No seam was composed, so the path reads for itself, as it did before one existed. */
  | { readonly status: 'unchecked' }
  | {
      readonly status: 'ready';
      readonly sides: readonly [JudgmentSide, JudgmentSide];
      readonly revision: EvidenceRevision;
    }
  | { readonly status: 'withheld'; readonly withheld: WithheldJudgment };

/**
 * The one gate every judgment path asks, so an abstention and an incomplete assembly stop a
 * judgment the same way wherever it runs, and a successful assembly reaches the prompt.
 */
export async function judgmentEvidenceFor(
  evidence: JudgmentEvidence | undefined,
  pair: JudgmentPair,
): Promise<JudgmentEvidenceOutcome> {
  if (evidence === undefined) {
    return { status: 'unchecked' };
  }
  const assembly = await evidence.assemble(pair);
  if (assembly.status === 'assembled') {
    return { status: 'ready', sides: assembly.sides, revision: assembly.revision };
  }
  if (assembly.status === 'abstained') {
    return {
      status: 'withheld',
      withheld: {
        kind: 'blocked',
        reason: assembly.reason,
        addresses: assembly.addresses,
        revision: assembly.revision,
      },
    };
  }
  return {
    status: 'withheld',
    withheld: {
      kind: 'retryable',
      reason: assembly.reasons.map((reason) => reason.reason).join(', '),
      addresses: assembly.reasons.map((reason) => reason.address),
      revision: assembly.revision,
    },
  };
}

/**
 * The statement a judge is shown: what the caller stated, and under it the sources the substrate
 * reserved for it. The evidence a judgment ran on has to be the evidence it was submitted.
 */
export function statementWithContext(statement: string, side: JudgmentSide | undefined): string {
  if (side === undefined || side.renderedContext.length === 0) {
    return statement;
  }
  return `${statement}\n\nEvidence, as captured:\n${side.renderedContext}`;
}

/**
 * The seam a judgment path holds. It carries the checked context it was built with, so a stage
 * never constructs a temporal vantage of its own to read evidence under.
 */
export type JudgmentEvidence = {
  assemble(pair: JudgmentPair): Promise<JudgmentAssembly>;
  /** Whether the evidence a returned judgment was made on still stands, before it is applied. */
  confirm(revision: EvidenceRevision): RevisionCheck;
};

/**
 * The evidence block a judge is actually shown, built here rather than in each adapter so the
 * text admitted against the allowance is the text submitted.
 */
function renderContext(
  sources: readonly SourceEvidence[],
  subjects: readonly ClaimSubject[],
): string {
  const lines = sources.map(
    (source) => `source ${source.sourceId}, as captured:\n${source.sourceText}`,
  );
  for (const subject of subjects) {
    if (subject.gloss !== undefined) {
      lines.push(`names ${subject.name}, currently described as: ${subject.gloss}`);
    }
  }
  return lines.join('\n\n');
}

function sideOf(
  request: JudgmentSideRequest,
  sources: readonly SourceEvidence[],
  subjects: readonly ClaimSubject[],
): JudgmentSide {
  const renderedContext = renderContext(sources, subjects);
  return {
    nodeId: request.nodeId,
    statement: request.statement,
    requiredSources: sources,
    optionalSubjects: subjects,
    renderedContext,
    renderedUnits:
      utf16CodeUnits(request.statement) + utf16CodeUnits(renderedContext) + RENDERED_SIDE_OVERHEAD,
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
  // Both sides' required units are reserved before either side's optional context is read, so a
  // gloss on the first side cannot spend the allowance the second side's own source needs.
  const required = pair.sides.map((side) =>
    readRequired(deps, side, pair, context, budget, dependencies),
  );
  const suppressed = required.flatMap((reading) => reading.suppressed);
  if (suppressed.length > 0) {
    return {
      status: 'abstained',
      reason: 'required_source_suppressed',
      addresses: suppressed,
      revision: dependencies.revision(),
    };
  }
  const blocking = required.flatMap((reading) => reading.issues);
  if (blocking.length > 0) {
    return { status: 'incomplete', reasons: blocking, revision: dependencies.revision() };
  }

  const allowance = renderableUnits({ route: pair.route, reservedUnits: pair.reservedUnits });
  const bare = pair.sides.map((side, index) => sideOf(side, required[index]?.sources ?? [], []));
  const requiredUnits = bare.reduce((total, side) => total + side.renderedUnits, 0);
  if (requiredUnits > allowance) {
    return {
      status: 'incomplete',
      reasons: pair.sides.map((side) => ({
        address: idAddress(side.nodeId),
        field: 'source_content' as const,
        reason: 'budget_limit' as const,
        required: true,
      })),
      revision: dependencies.revision(),
    };
  }

  // Whatever the required units left over, and no more. An omitted gloss is disclosed; it never
  // lowers what the required units say.
  const omitted: EvidenceIssue[] = [];
  const sides: JudgmentSide[] = [];
  let spent = requiredUnits;
  for (const [index, side] of pair.sides.entries()) {
    const sources = required[index]?.sources ?? [];
    const subjects = await readClaimSubjects(deps, {
      claimIds: [side.nodeId],
      context,
      budget,
    });
    dependencies.addAll(subjects.dependencies);
    omitted.push(...subjects.issues.map((issue) => ({ ...issue, required: false })));
    const optional = subjects.results.values().next().value?.value ?? [];
    const withContext = sideOf(side, sources, optional);
    const bareSide = bare[index] ?? withContext;
    const added = withContext.renderedUnits - bareSide.renderedUnits;
    if (spent + added > allowance) {
      omitted.push({
        address: idAddress(side.nodeId),
        field: 'interpretation_text',
        reason: 'budget_limit',
        required: false,
      });
      sides.push(bareSide);
      continue;
    }
    spent += added;
    sides.push(withContext);
  }

  const [first, second] = sides;
  if (first === undefined || second === undefined) {
    return {
      status: 'incomplete',
      reasons: pair.sides.map((side) => ({
        address: idAddress(side.nodeId),
        field: 'source_content' as const,
        reason: 'required_scope_missing' as const,
        required: true,
      })),
      revision: dependencies.revision(),
    };
  }
  return {
    status: 'assembled',
    sides: [first, second],
    revision: dependencies.revision(),
    omitted,
  };
}
