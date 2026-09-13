import type { TickReport } from './engine.js';
import type { Tier3Mode } from './tier3-advisor.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { errorMessage } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type { Decision, OperationCandidate } from '../domain/decide.js';
import type { HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation } from '../domain/operation.js';
import { acceptTier3Proposal, type Tier3Advisor, type Tier3Outcome } from '../domain/tier3.js';

/**
 * The whole tier-3 consultation: ask the model, gate the answer against the operation's own
 * record, and hand what clears to the engine's own act path. The engine keeps a call site and
 * none of this, so what runs a model-chosen operation is the same code that runs a
 * deterministic one and the difference between the two is a synthesized decision.
 *
 * Every terminal writes exactly one ledger row, so an operator reading the ledger sees what
 * the model was asked and what happened to its answer on every cycle that consulted it.
 */

/** Keyed by cycle rather than by clock: quarter-hour stamps collide across jittered ticks. */
export const TIER3_LEDGER_PREFIX = 'tier3:';

export function tier3LedgerKey(cycle: number): string {
  return `${TIER3_LEDGER_PREFIX}${String(cycle)}`;
}

type SelectedDecision = Extract<Decision, { kind: 'selected' }>;

export type Tier3ConsultDeps = {
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
  readonly advisor: Tier3Advisor;
  readonly operations: readonly IntrospectionOperation[];
  readonly signal: AbortSignal;
  /**
   * The engine's own act path, bound to this cycle. Bound rather than reimplemented so the
   * claim, the bound, the ledger row, and the effectiveness bookkeeping a tier-3 run leaves
   * behind are the same ones a tier-2 run leaves.
   */
  readonly act: (
    operation: IntrospectionOperation,
    decision: SelectedDecision,
  ) => Promise<TickReport>;
};

export type Tier3ConsultInput = {
  readonly health: HealthSnapshot;
  /** The set `decide()` saw: everything still unclaimed on this cycle. */
  readonly candidates: readonly OperationCandidate[];
  readonly reason: string;
  readonly cycle: number;
  /** Lessons the recent runs left, handed to the advisor with the reading. */
  readonly insights: readonly string[];
};

type LedgerSummary = {
  readonly reason: string;
  readonly mode: Tier3Mode;
  readonly outcome: string;
  readonly operation?: string;
  readonly confidence?: number;
  /** Confidence after the operation's own record weighted it, which is what the gate read. */
  readonly blended?: number;
  /** The weight that record came to, so the two numbers behind the gate are both on the row. */
  readonly weight?: number;
  readonly rationale?: string;
  readonly detail?: string;
  readonly gate?: string;
  readonly ran?: string;
};

function record(deps: Tier3ConsultDeps, input: Tier3ConsultInput, summary: LedgerSummary): void {
  markLedgerApplied(deps.db, tier3LedgerKey(input.cycle), summary);
  deps.logger.info({ cycle: input.cycle, ...summary }, 'introspection tier 3 consulted');
}

function describeOutcome(outcome: Tier3Outcome): LedgerSummary['detail'] {
  if (outcome.status === 'declined') {
    return outcome.rationale;
  }
  if (outcome.status === 'failed' || outcome.status === 'unusable') {
    return outcome.reason;
  }
  return undefined;
}

async function ask(deps: Tier3ConsultDeps, input: Tier3ConsultInput): Promise<Tier3Outcome> {
  try {
    return await deps.advisor({
      health: input.health,
      candidates: input.candidates,
      reason: input.reason,
      insights: input.insights,
      signal: deps.signal,
    });
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  }
}

/**
 * Returns a report only when an operation actually ran. Every other path leaves the cycle to
 * the engine, which answers with its own tier-3 decision.
 */
export async function consultTier3(
  deps: Tier3ConsultDeps,
  input: Tier3ConsultInput,
): Promise<TickReport | undefined> {
  const mode = deps.config.maintenance.tier3Mode;
  const base = { reason: input.reason, mode } as const;

  // The one skip before the model call. A cycle where nothing has work to do cannot end in an
  // accepted proposal, so the call would buy nothing and every idle tick would pay for it.
  // A degraded collector is not a skip: the operations that read it report no work of their own
  // and drop out here or at the gate, and the rest of the substrate is still worth thinking
  // about. Refusing the whole consultation over one failed collector was a broken thermometer
  // stopping the loop from noticing anything else.
  if (input.candidates.every((candidate) => candidate.relevance <= 0)) {
    record(deps, input, {
      ...base,
      outcome: 'skipped',
      detail: 'no candidate reports work to do',
    });
    return undefined;
  }

  const outcome = await ask(deps, input);
  if (outcome.status !== 'advised') {
    const detail = describeOutcome(outcome);
    record(deps, input, {
      ...base,
      outcome: outcome.status,
      ...(detail === undefined ? {} : { detail }),
    });
    return undefined;
  }

  const { proposal } = outcome;
  const acceptance = acceptTier3Proposal(
    proposal,
    input.candidates,
    input.health,
    deps.config.maintenance.tier3AcceptanceFloor,
  );
  const blended = acceptance.verdict === 'rejected' ? undefined : acceptance.blended;
  const weight = acceptance.verdict === 'rejected' ? undefined : acceptance.weight;
  const proposed = {
    ...base,
    outcome: outcome.status,
    operation: proposal.operation,
    confidence: proposal.confidence,
    ...(blended === undefined ? {} : { blended }),
    ...(weight === undefined ? {} : { weight }),
    rationale: proposal.rationale,
  };
  const gate =
    acceptance.verdict === 'accepted' ? 'accepted' : `${acceptance.verdict}: ${acceptance.reason}`;
  if (acceptance.verdict !== 'accepted' || mode !== 'act') {
    record(deps, input, { ...proposed, gate });
    return undefined;
  }

  const operation = deps.operations.find((entry) => entry.name === proposal.operation);
  if (operation === undefined) {
    record(deps, input, {
      ...proposed,
      gate,
      detail: 'the accepted operation is not registered',
    });
    return undefined;
  }

  // Urgency is the candidate's own relevance, which is the honest number: tier 3 fires below
  // the threshold by construction, so there is no score to report. The blended confidence goes
  // in the ledger row beside the raw one and the weight it was multiplied by, so what the gate
  // read is re-derivable from the row.
  const decision: SelectedDecision = {
    kind: 'selected',
    name: operation.name,
    tier: 3,
    urgency: acceptance.candidate.relevance,
    reason: `tier3: ${proposal.rationale}`,
  };

  // Scored by the same learn path as any run, and that scoring is the whole safeguard. A
  // model-chosen run that moves nothing reads as unchanged, which lowers the operation's
  // effectiveness, which lowers the blend on the next recommendation for it.
  const report = await deps.act(operation, decision);
  record(deps, input, {
    ...proposed,
    gate,
    ran: report.outcome === undefined ? 'the bucket was already claimed' : report.outcome.status,
  });
  return report;
}
