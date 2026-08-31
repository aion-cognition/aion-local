import type { OperationCandidate } from './decide.js';
import type { HealthSnapshot } from './health.js';
import type { Logger } from '../../infrastructure/logging/logger.js';

/**
 * The strategic tier: what the model may be asked, what it may answer, and the deterministic
 * rules that decide whether an answer is allowed to run.
 *
 * The constraint the whole tier is built on: a proposal is a recommendation, never an
 * execution. Whatever the model returns still passes the same bucket claim, the same protected
 * relationship set, and the same bounded scope every deterministic operation passes, and an
 * operation the model has never seen succeed is downgraded rather than accepted.
 */

export type Tier3Request = {
  readonly health: HealthSnapshot;
  readonly candidates: readonly OperationCandidate[];
  /** Why the deterministic tiers selected nothing, which is the only reason tier 3 is consulted. */
  readonly reason: string;
  /**
   * The loop's abort, carried on the request because the advisor is built once at wiring time
   * and the signal belongs to the engine. A consultation stops with the service rather than
   * holding shutdown for the rest of a model call.
   */
  readonly signal?: AbortSignal;
};

export type Tier3Proposal = {
  readonly operation: string;
  readonly confidence: number;
  readonly rationale: string;
};

/**
 * Four answers, kept apart on purpose. `declined` is the model saying the graph needs nothing,
 * which is a first-class answer and not a failure; `failed` is a call that threw or timed out,
 * and `unusable` an answer the schema refuses. A caller that folded the three into one silence
 * could not tell a healthy substrate from a broken advisor.
 */
export type Tier3Outcome =
  | { readonly status: 'advised'; readonly proposal: Tier3Proposal }
  | { readonly status: 'declined'; readonly rationale: string }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'unusable'; readonly reason: string };

export type Tier3Advisor = (request: Tier3Request) => Promise<Tier3Outcome>;

/**
 * What an accepted proposal is allowed to RUN. Everything else in the catalog stays a
 * recommendation the loop logs.
 *
 * Five operations are left out, each for its own reason. `redaction_residue_purge` rewrites
 * stored text and a wrong redaction destroys content permanently, which is why its own knob
 * caps a run at twenty nodes. `merge_auto` has its own arming lane and kill switch, and a
 * second way to arm it would defeat both. `symbiosis_bridge` writes model-authored edges into
 * the graph, so a model choosing to run it is a model authorizing its own writes.
 * `orphan_cleanup`, `emergency_relationship_repair`, and `vector_backfill` are tier-1
 * responders: when their condition is real, tier 1 fires on it, and tier 3 second-guessing a
 * critical responder is never the right call.
 */
export const TIER3_ACTABLE_OPERATIONS: readonly string[] = [
  'dead_letter',
  'reinforcement_flush',
  'memory_decay',
  'community_refresh',
  'narrative_cleanup',
  'reconcile_reenqueue',
  'narrative_regrounding',
  'description_freshness',
  'retro_judgment_sweep',
];

/**
 * `rejected` is a proposal the loop will not act on and would not have acted on in any mode.
 * `downgraded` is one the loop keeps as a recommendation: the reasoning may be sound, but the
 * operation is outside what tier 3 may run, or it has no track record to run on.
 */
export type Tier3Acceptance =
  | { readonly verdict: 'accepted' }
  | { readonly verdict: 'downgraded'; readonly reason: string }
  | { readonly verdict: 'rejected'; readonly reason: string };

/**
 * The deterministic gates every proposal passes before anything runs, in order.
 *
 * There is no confidence gate. A single judge's confidence measured flat across every
 * affirmative answer elsewhere in this system, which makes a threshold over it a pass-through
 * or a wall and never a discriminator; the second pass is what carries that weight here, and
 * confidence is recorded rather than acted on.
 */
export function acceptTier3Proposal(
  proposal: Tier3Proposal,
  candidates: readonly OperationCandidate[],
  health: HealthSnapshot,
): Tier3Acceptance {
  // Acting on a substrate the loop cannot see is the one forbidden thing, and the consultation
  // already refuses before the model call. This is the second reading of the same rule.
  if (health.degraded.length > 0) {
    return {
      verdict: 'rejected',
      reason: `the snapshot is degraded: ${health.degraded.join(', ')}`,
    };
  }

  const candidate = candidates.find((entry) => entry.name === proposal.operation);
  if (candidate === undefined) {
    return { verdict: 'rejected', reason: 'the operation is not a candidate on this cycle' };
  }
  if (candidate.relevance <= 0) {
    return { verdict: 'rejected', reason: 'the operation reports no work to do' };
  }

  if (!TIER3_ACTABLE_OPERATIONS.includes(proposal.operation)) {
    return { verdict: 'downgraded', reason: 'the operation is outside the act allowlist' };
  }

  // Never the first-run path. The tier-2 starvation boost is linear and uncapped off cycles
  // waited, so every operation with relevance above zero earns its first run there eventually;
  // this rule delays a model-chosen run until the record exists, it cannot strand one.
  const stats = health.effectiveness.find((entry) => entry.name === proposal.operation);
  if (stats === undefined || stats.runs === 0) {
    return { verdict: 'downgraded', reason: 'the operation has never been seen to succeed' };
  }

  return { verdict: 'accepted' };
}

/**
 * The advisor that recommends nothing: it writes what the deterministic tiers could not decide
 * and declines. It is what the engine falls back to when no model advisor is wired, so a loop
 * built without one still records how often the strategic layer was consulted.
 */
export function proposeOnlyAdvisor(logger: Logger): Tier3Advisor {
  return (request) => {
    const rationale = 'propose-only advisor, no model consulted';
    logger.info(
      {
        reason: request.reason,
        candidates: request.candidates.map((candidate) => candidate.name),
        vectorParity: request.health.graph.vectorParity,
        orphanShare: request.health.graph.orphanShare,
        queueDepth: request.health.queue.depth,
      },
      'introspection tier 3 consulted; propose-only, no operation selected',
    );
    return Promise.resolve({ status: 'declined', rationale });
  };
}
