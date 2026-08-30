import type { OperationCandidate } from './decide.js';
import type { HealthSnapshot } from './health.js';
import type { Logger } from '../../infrastructure/logging/logger.js';

/**
 * The seam tier 3 will land on, and nothing more. The full layer composes a schema-aware
 * prompt from the snapshot, the operation catalog, and the recent effectiveness stats, blends
 * the model's confidence with those stats, and selects an operation when the blend clears a
 * threshold. None of that is built here: what ships is the shape of the call and the
 * opt-in flag, so the loop that will make it exists and does nothing until it does.
 *
 * The constraint the full implementation inherits: a proposal is a recommendation, never an
 * execution. Whatever the model returns still passes the same bucket claim, the same protected
 * relationship set, and the same bounded scope every deterministic operation passes, and an
 * operation the model has never seen succeed is downgraded before it is accepted.
 */

export type Tier3Request = {
  readonly health: HealthSnapshot;
  readonly candidates: readonly OperationCandidate[];
  /** Why the deterministic tiers selected nothing, which is the only reason tier 3 is consulted. */
  readonly reason: string;
};

export type Tier3Proposal = {
  readonly operation: string;
  readonly confidence: number;
  readonly rationale: string;
};

/** Returns the operation it would recommend, or `undefined` to leave the cycle idle. */
export type Tier3Advisor = (request: Tier3Request) => Promise<Tier3Proposal | undefined>;

/**
 * The advisor the engine uses while tier 3 is unbuilt: it writes what the deterministic tiers
 * could not decide and recommends nothing. Turning the flag on therefore produces a record of
 * how often the strategic layer would have been consulted, which is the measurement the full
 * implementation needs and the only thing it can safely give today.
 */
export function proposeOnlyAdvisor(logger: Logger): Tier3Advisor {
  return (request) => {
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
    return Promise.resolve(undefined);
  };
}
