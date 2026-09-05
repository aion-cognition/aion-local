import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * What every generation route has done since this counter shipped: calls, failures, and what a
 * call costs. A generation used to end at a debug log, so a remote route failing every call
 * read from the outside exactly like a route nobody had asked for. A rate survives a restart
 * here, which is what lets the maintenance loop and `aion stats` answer that question.
 *
 * The role and provider names are declared here rather than imported from the providers layer,
 * the way `method-counters.ts` declares its own method list: a counter key is a string in the
 * meta table, and the store that holds it outlives whatever the layer above renames. This
 * module's test holds both lists against the routing they count.
 */
export const GENERATION_COUNTER_ROLES = ['cue', 'reflect'] as const;

export const GENERATION_COUNTER_PROVIDERS = ['ollama', 'anthropic'] as const;

export type GenerationCounterRole = (typeof GENERATION_COUNTER_ROLES)[number];

export type GenerationCounterProvider = (typeof GENERATION_COUNTER_PROVIDERS)[number];

/** One generation as the router reports it: which route ran, whether it answered, what it cost. */
export type GenerationOutcome = {
  readonly role: GenerationCounterRole;
  readonly provider: GenerationCounterProvider;
  readonly ok: boolean;
  readonly durationMs: number;
};

export type GenerationRouteStat = {
  readonly role: GenerationCounterRole;
  readonly provider: GenerationCounterProvider;
  readonly calls: number;
  readonly failed: number;
  /** Failures over calls, `undefined` on a route nothing has taken: no calls is not a clean record. */
  readonly failureRate: number | undefined;
  /** Mean over every timed call, failures included, so a route that hangs reads as expensive. */
  readonly meanDurationMs: number | undefined;
};

export type GenerationCounters = {
  /** One row per route the router can take, zeroed rather than absent where nothing ran. */
  readonly routes: readonly GenerationRouteStat[];
  readonly calls: number;
  readonly failed: number;
  /** `undefined` until the first generation, so a fresh install reads as unmeasured, not healthy. */
  readonly failureRate: number | undefined;
};

const GENERATION_PREFIX = 'generation:';

function key(role: string, provider: string, leaf: string): string {
  return `${GENERATION_PREFIX}${role}:${provider}:${leaf}`;
}

function readCount(db: SqliteHandle, metaKey: string): number {
  const parsed = Number(getMeta(db, metaKey) ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(part: number, total: number): number | undefined {
  if (total <= 0) {
    return undefined;
  }
  return part / total;
}

/**
 * One generation's record. Cheap on purpose: four meta rows in one transaction, no graph and no
 * network, because the cue role calls this on the recall hot path.
 *
 * The reads and the writes are one unit, as in the counters beside this one: two connections
 * incrementing off one base lose whichever call resolved second.
 */
export function recordGenerationOutcome(db: SqliteHandle, outcome: GenerationOutcome): void {
  const { role, provider } = outcome;
  const outcomeKey = key(role, provider, outcome.ok ? 'ok' : 'failed');
  const runsKey = key(role, provider, 'duration_runs');
  const totalKey = key(role, provider, 'duration_total_ms');
  db.transaction(() => {
    setMeta(db, outcomeKey, String(readCount(db, outcomeKey) + 1));
    setMeta(db, runsKey, String(readCount(db, runsKey) + 1));
    setMeta(db, totalKey, String(readCount(db, totalKey) + Math.max(0, outcome.durationMs)));
  }).immediate();
}

function routeStat(
  db: SqliteHandle,
  role: GenerationCounterRole,
  provider: GenerationCounterProvider,
): GenerationRouteStat {
  const ok = readCount(db, key(role, provider, 'ok'));
  const failed = readCount(db, key(role, provider, 'failed'));
  const durationRuns = readCount(db, key(role, provider, 'duration_runs'));
  const durationTotalMs = readCount(db, key(role, provider, 'duration_total_ms'));
  return {
    role,
    provider,
    calls: ok + failed,
    failed,
    failureRate: rate(failed, ok + failed),
    meanDurationMs: durationRuns <= 0 ? undefined : durationTotalMs / durationRuns,
  };
}

/** Every route's record, plus the substrate-wide rate a health snapshot reads. */
export function generationCounters(db: SqliteHandle): GenerationCounters {
  const routes = GENERATION_COUNTER_ROLES.flatMap((role) =>
    GENERATION_COUNTER_PROVIDERS.map((provider) => routeStat(db, role, provider)),
  );
  const calls = routes.reduce((total, route) => total + route.calls, 0);
  const failed = routes.reduce((total, route) => total + route.failed, 0);
  return { routes, calls, failed, failureRate: rate(failed, calls) };
}
