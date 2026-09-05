import {
  acceptsHookCapture,
  queueLagSnapshot,
  resolveProviderRouting,
  scanHorizonIntegrity,
  type Config,
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
