import {
  acceptsHookCapture,
  queueLagSnapshot,
  readCoverageState,
  resolveProviderRouting,
  scanHorizonIntegrity,
  type Config,
  type CoverageStateReport,
  type HorizonIntegrity,
  type SqliteHandle,
} from '@aion/core';
import type { Driver } from 'neo4j-driver';

import type { CheckResult } from './doctor.js';

/**
 * The checks that read a substrate and answer with a verdict, kept apart from the file that
 * orders them and prints the report. `doctor.ts` composes; each function here owns one
 * invariant and the sentence it reports it in.
 */

/**
 * Pure SQLite, no Neo4j: `aion doctor` printed "8 checks passed" with 4,000+ jobs pending,
 * and again with one permanently wedged job. Warn, never fail: a backlog is a thing that is
 * behind, not a thing that is broken.
 */
export function queueLagCheck(
  db: SqliteHandle,
  config: Config,
  now: Date = new Date(),
): CheckResult {
  const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts, now);
  const { interactive, bulk } = snapshot.depthByLane;
  const depth = interactive + bulk;
  const oldest = snapshot.oldestUnclaimedMs;
  const detail = [
    `depth ${String(depth)} (interactive ${String(interactive)}, bulk ${String(bulk)})`,
    `oldest unclaimed ${oldest === undefined ? 'none' : `${String(Math.round(oldest / 1000))}s`}`,
    `${String(snapshot.exhausted)} exhausted`,
    `${String(snapshot.reinforcementDropped)} reinforcement rows dropped`,
    snapshot.p95EnrichmentLagMs === undefined
      ? 'no enrichment lag samples yet'
      : `p95 enrichment lag ${String(Math.round(snapshot.p95EnrichmentLagMs / 1000))}s`,
    snapshot.cueDegradedRate === undefined
      ? 'no recalls measured yet'
      : `${(snapshot.cueDegradedRate * 100).toFixed(1)}% of recent recalls degraded on cues`,
  ].join(', ');

  const stale = oldest !== undefined && oldest > config.operational.lagOldestUnclaimedWarnMs;
  const deep = depth > config.operational.lagQueueDepthWarnThreshold;
  if (stale || deep) {
    return { ok: true, warn: true, detail };
  }
  return { ok: true, detail };
}

/**
 * A reading's horizon is annotated at read and is never a close, so a node carrying a horizon
 * and a `valid_until` at once is read rather than assumed broken: a reading a later observation
 * corrected carries exactly that pair, and the close records when the correcting experience
 * happened.
 *
 * A close stamped at the horizon itself is the failure. That node left every currency predicate
 * in the tree with nothing having corrected it, and the `coalesce` on the next real close keeps
 * the wrong world time under a live lineage edge. Fails rather than warns: it is a wrong answer
 * the substrate gives now, and `aion unsupersede` is the verb that lifts it.
 */
export function horizonIntegrityCheck(report: HorizonIntegrity): CheckResult {
  if (report.closedAtHorizon === 0) {
    return {
      ok: true,
      detail:
        `${String(report.withHorizon)} readings carry a horizon, ` +
        `${String(report.closed)} of them superseded`,
    };
  }
  return {
    ok: false,
    detail:
      `${String(report.closedAtHorizon)} of ${String(report.withHorizon)} carry a close ` +
      `stamped at their own horizon (${report.sampleIds.join(', ')}); ` +
      '`aion unsupersede <id>` reopens each one',
  };
}

/** The same verdict over a live substrate, which is how `aion doctor` reaches it. */
export async function readingHorizonCheck(driver: Driver): Promise<CheckResult> {
  return horizonIntegrityCheck(await scanHorizonIntegrity(driver));
}

/**
 * What the substrate says it covers, and the fence it says nothing about.
 *
 * A preparing contract is the state a substrate is in between initialization and the activation
 * the service publishes on its next start. It serves, so this warns rather than fails, and it
 * names what the state costs: no temporal read carries a horizon while it holds. An unreadable
 * record fails, because every covered read refuses against one, present-tense reads included.
 *
 * The eviction clause is spelled out rather than left to inference. The two gates live on one
 * row and an active contract arms nothing.
 */
export function coverageStateCheck(report: CoverageStateReport): CheckResult {
  const fence =
    report.evictionGate === 'unarmed'
      ? 'eviction fence closed (no compatibility revision)'
      : `eviction fence ARMED at compatibility revision ${String(report.evictionCompatibilityRevision)}`;
  if (report.coverageState === 'failed') {
    return {
      ok: false,
      detail: `no servable coverage record; every covered read refuses. ${fence}`,
    };
  }
  if (report.coverageState === 'preparing') {
    return {
      ok: true,
      warn: true,
      detail:
        'contract preparing: temporal reads answer partial with coverage_contract_not_active, ' +
        `and no read carries a history horizon. The service activates it at start. ${fence}`,
    };
  }
  return {
    ok: true,
    detail: `contract active, history since ${report.historySince ?? 'unrecorded'}. ${fence}`,
  };
}

/** The same verdict over a live substrate, which is how `aion doctor` reaches it. */
export function coverageCheck(db: SqliteHandle): CheckResult {
  return coverageStateCheck(readCoverageState(db));
}

/**
 * Hooks push raw transcript windows at every turn, and only the keyed route digests that
 * volume. The resolved reflect route answers the routing half, so a key pinned back to Ollama
 * reads as the local profile it is. Whether hooks are installed is a host fact: the CLI runs in
 * a container that cannot see `~/.claude`, so `bin/aion` computes it and passes it through, and
 * a run reached any other way reports that it cannot see rather than guessing.
 */
export function hooksKeyedOnlyCheck(config: Config, env: NodeJS.ProcessEnv): CheckResult {
  const installed = (env.AION_HOOKS_INSTALLED ?? '').trim();
  if (installed === '') {
    return { ok: true, detail: 'hook settings not visible here' };
  }
  if (installed !== 'true') {
    return { ok: true, detail: 'no hooks installed' };
  }
  const routing = resolveProviderRouting(config);
  if (acceptsHookCapture(routing)) {
    return { ok: true, detail: 'hooks installed, keyed' };
  }
  return {
    ok: false,
    detail:
      `hooks are installed but reflection runs locally on ${routing.roles.reflect.model}; ` +
      'set AION_ANTHROPIC_API_KEY in .env, or remove the hooks (`aion hooks uninstall`; ' +
      'the hook client also strips them on its next fire)',
  };
}
