import type { Driver } from 'neo4j-driver';

import { observeHealth, readOperationEffectiveness, type ObserveOptions } from './observe.js';
import {
  readMeasure,
  recordRunOutcome,
  resolvePendingMeasures,
  type ResolvedRun,
} from './operation-scoring.js';
import { consultTier3 } from './tier3-consult.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { errorMessage } from '../../infrastructure/errors.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  claimOperationBucket,
  nextIntrospectionCycle,
  recordOperationRun,
  recordOperationSelected,
} from '../../infrastructure/sqlite/introspection-counters.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { operationBucketKey } from '../domain/buckets.js';
import { decide, type Decision, type OperationCandidate } from '../domain/decide.js';
import { neutralSnapshot, type HealthSnapshot } from '../domain/health.js';
import {
  operationMeasurements,
  type IntrospectionOperation,
  type OperationOutcome,
} from '../domain/operation.js';
import { proposeOnlyAdvisor, type Tier3Advisor } from '../domain/tier3.js';

/**
 * The introspection loop: observe, decide, act, learn, on a clock the service owns.
 *
 * Two rules shape everything below. Maintenance must not run twice for the same window, so an
 * operation claims its time bucket in the ops ledger before it starts, and a tick that loses
 * the claim decides again without that operation rather than repeating it or giving up its
 * turn. And maintenance must not be the thing that breaks: a collector that throws costs its
 * metrics, an operation that throws costs its own turn, and neither ends the loop.
 */

/** How far the tick is nudged either side of the interval, so two instances drift apart instead of colliding every time. */
export const DEFAULT_TICK_JITTER = 0.1;

/** Each consecutive failed observation doubles the wait, up to this many intervals. */
export const MAX_BACKOFF_FACTOR = 8;

const MINUTE_MS = 60 * 1000;

export type IntrospectorDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly config: Config;
  readonly logger: Logger;
  /** Handed to every operation through its context, so the whole loop shares one breaker. */
  readonly provider: Provider;
  /**
   * The registered catalog, in order. Order decides nothing on its own: selection is by tier
   * and urgency, and ties break on waiting time and then on name.
   */
  readonly operations: readonly IntrospectionOperation[];
};

export type IntrospectorOptions = {
  readonly tickMs?: number;
  readonly jitter?: number;
  /** Test seam: the engine never observes any other way. */
  readonly observe?: (options: ObserveOptions) => Promise<HealthSnapshot>;
  readonly tier3Advisor?: Tier3Advisor;
  readonly now?: () => Date;
};

export type TickReport = {
  readonly cycle: number;
  readonly health: HealthSnapshot;
  readonly decision: Decision;
  /**
   * Absent when nothing ran: an idle cycle, a consultation that recommended nothing or could
   * not act, or a bucket someone else claimed. A tier-3 cycle that acted carries its outcome.
   */
  readonly outcome?: OperationOutcome;
  /** True when every operation the cycle selected had its bucket claimed already. */
  readonly skipped: boolean;
  /** Operations whose earlier run was scored against this snapshot. */
  readonly resolved: readonly ResolvedRun[];
};

export class Introspector {
  readonly #deps: IntrospectorDeps;
  readonly #tickMs: number;
  readonly #jitter: number;
  readonly #observe: (options: ObserveOptions) => Promise<HealthSnapshot>;
  readonly #tier3Advisor: Tier3Advisor;
  readonly #now: () => Date;
  readonly #abort = new AbortController();
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> = Promise.resolve();
  #stopped = false;
  #backoffFactor = 1;

  constructor(deps: IntrospectorDeps, options: IntrospectorOptions = {}) {
    this.#deps = deps;
    this.#tickMs = options.tickMs ?? deps.config.maintenance.tickMinutes * MINUTE_MS;
    this.#jitter = options.jitter ?? DEFAULT_TICK_JITTER;
    this.#observe =
      options.observe ??
      ((observeOptions) =>
        observeHealth(
          {
            driver: deps.driver,
            db: deps.db,
            config: deps.config,
            logger: deps.logger,
          },
          observeOptions,
        ));
    this.#tier3Advisor = options.tier3Advisor ?? proposeOnlyAdvisor(deps.logger);
    this.#now = options.now ?? ((): Date => new Date());
  }

  get tickMs(): number {
    return this.#tickMs;
  }

  /** Rises while observation keeps failing, back to 1 on the first cycle that sees the substrate. */
  get backoffFactor(): number {
    return this.#backoffFactor;
  }

  /**
   * The next delay: the interval, stretched by any backoff, then jittered. Two instances
   * started together would otherwise tick together forever, and every bucket claim would be a
   * race one of them always loses.
   */
  nextDelayMs(random: number = Math.random()): number {
    const offset = (random * 2 - 1) * this.#jitter;
    return Math.max(1, Math.round(this.#tickMs * this.#backoffFactor * (1 + offset)));
  }

  /**
   * Unreferenced: a substrate with nothing to maintain must not be the reason the process
   * stays alive. The first tick is one interval out, since a service that just started has
   * nothing the previous run did not already leave in the state it is in.
   */
  start(): void {
    if (this.#timer !== undefined || this.#stopped) {
      return;
    }
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#abort.abort();
    await this.whenIdle();
  }

  /** Resolves once the tick in progress, if any, has settled. */
  async whenIdle(): Promise<void> {
    await this.#pending;
  }

  /**
   * One timer, rearmed from the end of each tick rather than a repeating interval, so a tick
   * that outruns its own period delays the next one instead of stacking on top of it.
   */
  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.#pending = this.#pending.then(async () => {
        try {
          await this.tickOnce();
        } catch (err) {
          // The loop outlives every tick. Whatever a cycle could not survive, the next one
          // starts clean rather than the timer stopping with the process still up.
          this.#deps.logger.error({ err }, 'introspection tick failed');
        }
        if (!this.#stopped) {
          this.#schedule();
        }
      });
    }, this.nextDelayMs());
    this.#timer.unref();
  }

  /**
   * Exposed so a caller can drive one cycle without waiting out an interval.
   *
   * An observation that fails takes the cycle with it: the engine falls back to a reading of
   * nothing, which selects nothing, and lengthens the wait before the next attempt. Acting on
   * a substrate it cannot see is the one thing a self-repairing loop must not do.
   */
  async tickOnce(): Promise<TickReport> {
    const cycle = nextIntrospectionCycle(this.#deps.db);
    const measurements = operationMeasurements(this.#deps.operations);
    const at = this.#now();
    let observed: HealthSnapshot;
    try {
      observed = await this.#observe({ operations: measurements, cycle, now: at });
      this.#backoffFactor = 1;
    } catch (err) {
      this.#backoffFactor = Math.min(MAX_BACKOFF_FACTOR, this.#backoffFactor * 2);
      this.#deps.logger.error(
        { err, cycle, backoff: this.#backoffFactor },
        'introspection observation failed',
      );
      const health = neutralSnapshot(cycle, at.toISOString());
      return {
        cycle,
        health,
        decision: { kind: 'idle', reason: 'observation failed' },
        skipped: false,
        resolved: [],
      };
    }

    // Scoring the previous run before deciding, then re-reading the record it just changed:
    // an operation that failed last cycle should be weighted down on this one, not the next.
    const resolved = resolvePendingMeasures(this.#deps, this.#deps.operations, observed);
    const health: HealthSnapshot = {
      ...observed,
      effectiveness: readOperationEffectiveness(this.#deps.db, measurements, cycle),
    };

    const candidates = this.#deps.operations.map((operation) => this.#candidate(operation, health));

    // Deciding again when a claim is lost, rather than ending the tick. One operation whose
    // relevance sits at the top of the catalog and whose bucket is an hour wide would otherwise
    // be selected on every tick inside that hour and run on none of them, and the eleven other
    // operations would wait out the hour behind it. The set only shrinks, so this terminates.
    const claimedElsewhere = new Set<string>();
    let skippedReport: TickReport | undefined;
    for (let attempt = 0; attempt <= candidates.length; attempt += 1) {
      const available = candidates.filter((candidate) => !claimedElsewhere.has(candidate.name));
      const decision = decide({
        health,
        candidates: available,
        starvationCycles: this.#deps.config.maintenance.starvationCycles,
        urgencyThreshold: this.#deps.config.maintenance.urgencyThreshold,
        effectivenessFloor: this.#deps.config.maintenance.effectivenessFloor,
        tier3Enabled: this.#deps.config.maintenance.tier3,
      });

      // The strategic layer is consulted first, before the skipped-claim fall-through below: a
      // cycle that lost a claim is exactly the cycle the deterministic tiers had least to offer
      // on. It sees the candidates the decision saw, so it cannot name a claimed operation.
      if (decision.kind === 'tier3') {
        const acted = await this.#consultTier3(health, available, decision.reason, cycle, resolved);
        if (acted !== undefined) {
          return acted;
        }
        return { cycle, health, decision, skipped: skippedReport !== undefined, resolved };
      }
      // Once a claim has been lost, running out of candidates means the window is covered by
      // whoever holds it, which is a skipped cycle rather than an idle one.
      if (decision.kind !== 'selected' && skippedReport !== undefined) {
        return skippedReport;
      }
      if (decision.kind === 'idle') {
        this.#deps.logger.debug({ cycle }, 'introspection cycle idle');
        return { cycle, health, decision, skipped: false, resolved };
      }

      const operation = this.#deps.operations.find((entry) => entry.name === decision.name);
      if (operation === undefined) {
        this.#deps.logger.error(
          { cycle, operation: decision.name },
          'selected operation is not registered',
        );
        return { cycle, health, decision, skipped: false, resolved };
      }

      skippedReport = await this.#act(operation, decision, health, cycle, resolved);
      if (!skippedReport.skipped) {
        return skippedReport;
      }
      claimedElsewhere.add(decision.name);
    }

    // Unreachable in practice: an empty candidate set decides idle and returns above. The
    // report from the last claim that was lost is the honest answer if it ever is reached.
    return (
      skippedReport ?? {
        cycle,
        health,
        decision: { kind: 'idle', reason: 'every candidate is claimed' },
        skipped: false,
        resolved,
      }
    );
  }

  /** A relevance that throws is a zero, not a crash: a broken scorer must not take the loop with it. */
  #candidate(operation: IntrospectionOperation, health: HealthSnapshot): OperationCandidate {
    const answers = operation.answers === undefined ? {} : { answers: operation.answers };
    try {
      return { name: operation.name, ...answers, relevance: operation.relevance(health) };
    } catch (err) {
      this.#deps.logger.warn({ err, operation: operation.name }, 'operation relevance failed');
      return { name: operation.name, ...answers, relevance: 0 };
    }
  }

  /** Answers a report only when the consultation ran an operation; otherwise the cycle is idle. */
  async #consultTier3(
    health: HealthSnapshot,
    candidates: readonly OperationCandidate[],
    reason: string,
    cycle: number,
    resolved: readonly ResolvedRun[],
  ): Promise<TickReport | undefined> {
    try {
      return await consultTier3(
        {
          ...this.#deps,
          advisor: this.#tier3Advisor,
          signal: this.#abort.signal,
          act: (operation, decision) => this.#act(operation, decision, health, cycle, resolved),
        },
        { health, candidates, reason, cycle },
      );
    } catch (err) {
      this.#deps.logger.warn({ err }, 'introspection tier 3 consultation failed');
      return undefined;
    }
  }

  async #act(
    operation: IntrospectionOperation,
    decision: Extract<Decision, { kind: 'selected' }>,
    health: HealthSnapshot,
    cycle: number,
    resolved: readonly ResolvedRun[],
  ): Promise<TickReport> {
    const now = this.#now();
    const key = operationBucketKey(operation.name, operation.bucket, now);

    // Selection is what starvation measures, so the stamp lands even when the claim is lost:
    // the window is covered either way, and an operation that keeps losing races has not been
    // neglected.
    recordOperationSelected(this.#deps.db, operation.name, cycle);

    const claimed = claimOperationBucket(this.#deps.db, key, {
      operation: operation.name,
      cycle,
      tier: decision.tier,
      status: 'claimed',
    });
    if (!claimed) {
      this.#deps.logger.debug(
        { cycle, operation: operation.name, key },
        'maintenance bucket already claimed',
      );
      return { cycle, health, decision, skipped: true, resolved };
    }

    const before = readMeasure(this.#deps, operation, health);
    recordOperationRun(this.#deps.db, operation.name, now.toISOString());

    // Wall time, read from the monotonic clock rather than from `#now`: the injected clock is
    // fixed in tests and world time is not what a run costs.
    const startedAt = performance.now();
    let outcome: OperationOutcome;
    try {
      outcome = await operation.run({
        driver: this.#deps.driver,
        db: this.#deps.db,
        config: this.#deps.config,
        logger: this.#deps.logger,
        provider: this.#deps.provider,
        health,
        now,
        signal: this.#abort.signal,
      });
    } catch (err) {
      outcome = {
        status: 'failed',
        itemsProcessed: 0,
        itemsAffected: 0,
        detail: errorMessage(err),
      };
      this.#deps.logger.error(
        { err, operation: operation.name, cycle },
        'maintenance operation failed',
      );
    }

    markLedgerApplied(this.#deps.db, key, {
      operation: operation.name,
      cycle,
      tier: decision.tier,
      urgency: decision.urgency,
      reason: decision.reason,
      status: outcome.status,
      itemsProcessed: outcome.itemsProcessed,
      itemsAffected: outcome.itemsAffected,
      ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
    });

    const durationMs = performance.now() - startedAt;
    recordRunOutcome(this.#deps, operation, outcome, before, durationMs);
    this.#deps.logger.info(
      {
        cycle,
        operation: operation.name,
        tier: decision.tier,
        // Why this operation won the tick. A tier-1 preemption names the condition it answers,
        // and without both fields the reason lived only in the SQLite ledger row.
        urgency: decision.urgency,
        reason: decision.reason,
        status: outcome.status,
        itemsProcessed: outcome.itemsProcessed,
        itemsAffected: outcome.itemsAffected,
        durationMs: Math.round(durationMs),
      },
      'maintenance operation ran',
    );
    return { cycle, health, decision, outcome, skipped: false, resolved };
  }
}
