import type { TickReport } from './engine.js';
import { reviewTier3Proposal, type Tier3Mode } from './tier3-advisor.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { errorMessage } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import type { Decision, OperationCandidate } from '../domain/decide.js';
import type { HealthSnapshot } from '../domain/health.js';
import type { IntrospectionOperation } from '../domain/operation.js';
import {
  acceptTier3Proposal,
  type Tier3Advisor,
  type Tier3Outcome,
  type Tier3Proposal,
} from '../domain/tier3.js';

/**
 * The whole tier-3 consultation: ask the model, gate the answer, argue the other side of it,
 * and hand what survives to the engine's own act path. The engine keeps a call site and none
 * of this, so what runs a model-chosen operation is the same code that runs a deterministic
 * one and the difference between the two is a synthesized decision.
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
  /** The loop's shared provider, which is what the second pass runs on. */
  readonly provider: Pick<Provider, 'generate'>;
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
};

type LedgerSummary = {
  readonly reason: string;
  readonly mode: Tier3Mode;
  readonly outcome: string;
  readonly operation?: string;
  readonly confidence?: number;
  readonly rationale?: string;
  readonly detail?: string;
  readonly gate?: string;
  readonly review?: string;
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
      signal: deps.signal,
    });
  } catch (error) {
    return { status: 'failed', reason: errorMessage(error) };
  }
}

async function secondPass(
  deps: Tier3ConsultDeps,
  input: Tier3ConsultInput,
  proposal: Tier3Proposal,
): Promise<{ readonly upheld: boolean; readonly detail: string }> {
  let review;
  try {
    review = await reviewTier3Proposal(
      deps.provider,
      { health: input.health, candidates: input.candidates, reason: input.reason },
      proposal,
      {
        model: deps.config.models.reflect,
        timeoutMs: deps.config.reflection.stageTimeoutMs,
        signal: deps.signal,
      },
    );
  } catch (error) {
    return { upheld: false, detail: `failed: ${errorMessage(error)}` };
  }
  if (review.status === 'upheld') {
    return { upheld: true, detail: 'upheld' };
  }
  // A review that threw, timed out, or came back unusable counts as a veto. A recommendation
  // the substrate cannot defend is one it does not run.
  return { upheld: false, detail: `${review.status}: ${review.reason}` };
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

  // Two skips before the model call, for the same reason: neither can end in an accepted
  // proposal, so the call would buy nothing and every idle tick would pay for it.
  if (input.health.degraded.length > 0) {
    record(deps, input, {
      ...base,
      outcome: 'skipped',
      detail: `the snapshot is degraded: ${input.health.degraded.join(', ')}`,
    });
    return undefined;
  }
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
  const proposed = {
    ...base,
    outcome: outcome.status,
    operation: proposal.operation,
    confidence: proposal.confidence,
    rationale: proposal.rationale,
  };
  const acceptance = acceptTier3Proposal(proposal, input.candidates, input.health);
  const gate =
    acceptance.verdict === 'accepted' ? 'accepted' : `${acceptance.verdict}: ${acceptance.reason}`;
  if (acceptance.verdict !== 'accepted' || mode !== 'act') {
    record(deps, input, { ...proposed, gate });
    return undefined;
  }

  const review = await secondPass(deps, input, proposal);
  if (!review.upheld) {
    record(deps, input, { ...proposed, gate, review: review.detail });
    return undefined;
  }

  const operation = deps.operations.find((entry) => entry.name === proposal.operation);
  const candidate = input.candidates.find((entry) => entry.name === proposal.operation);
  if (operation === undefined || candidate === undefined) {
    record(deps, input, {
      ...proposed,
      gate,
      review: review.detail,
      detail: 'the accepted operation is not registered',
    });
    return undefined;
  }

  // Urgency is the candidate's own relevance, which is the honest number: tier 3 fires below
  // the threshold by construction, so there is no score to report. The model's confidence goes
  // in the ledger row and gates nothing.
  const decision: SelectedDecision = {
    kind: 'selected',
    name: operation.name,
    tier: 3,
    urgency: candidate.relevance,
    reason: `tier3: ${proposal.rationale}`,
  };

  // Scored by the same learn path as any run. A model-chosen run that moves nothing reads as
  // unchanged, and that is the feedback that teaches the deterministic tiers the operation was
  // not needed.
  const report = await deps.act(operation, decision);
  record(deps, input, {
    ...proposed,
    gate,
    review: review.detail,
    ran: report.outcome === undefined ? 'the bucket was already claimed' : report.outcome.status,
  });
  return report;
}
