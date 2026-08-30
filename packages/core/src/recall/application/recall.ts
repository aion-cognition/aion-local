import {
  RecallInputSchema,
  type Degradation,
  type MemoryPack,
  type PackTruncation,
  type RecallInput,
  type RecallOutput,
  type StageTimingsMs,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import { fetchAdjacency } from '../../infrastructure/graph/adjacency.js';
import { asOf, bitemporalAt, knewAt, withCurrency, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SessionManager } from '../../session/session-manager.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { saveLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { recordPackMethodCounts } from '../../infrastructure/sqlite/method-counters.js';
import { recordRecallOutcome } from '../../infrastructure/sqlite/recall-cadence.js';
import { recordCueOutcome } from '../../infrastructure/sqlite/recall-samples.js';
import {
  spreadActivation,
  type ActivatedNode,
  type ActivationBudget,
  type ActivationRun,
  type ActivationTermination,
  type AdjacencyFetch,
} from '../domain/activation.js';
import { labelBoosts, queryCueTexts, queryRestatements } from '../domain/facts.js';
import { buildRankedLists, toActivationSeed } from './candidates.js';
import { extractCues, type CueCache, type CueExtractionResult } from './cues.js';
import type { AdmissionPolicy, AdmissionReport } from '../domain/admission.js';
import { fuse, type FusedItem, type FusionResult } from '../domain/fusion.js';
import { assemblePack, packMethods, type BucketCaps } from '../domain/pack.js';
import { resonate, type ResonanceResult } from './resonance.js';
import { selectSeeds, type Seed } from './seeds.js';
import {
  embedCues,
  hydrate,
  measureArrivals,
  mmrVectors,
  pendingEnrichment,
} from './stage-reads.js';

/**
 * The recall pipeline, in the order its stages run. Cue extraction spends the one generation
 * call recall is allowed, every cue is embedded in a single batch, the four seed strategies
 * run, activation spreads from what they found, fusion ranks the union, context resonance
 * makes its second pass over what activation reached, and the pack is assembled and persisted.
 *
 * `as_of` / `knew_at` bind one read mode for the whole run: currency is judged from a single
 * vantage point, so seeds, traversal, and hydration cannot disagree about what was true when.
 */

export type RecallCompletion = {
  readonly sessionId: string;
  readonly seeds: readonly Seed[];
  /** The co-activated set, seeds included, for the reinforcement side effects. */
  readonly activated: readonly ActivatedNode[];
  readonly items: readonly FusedItem[];
  /** What the admission gate dropped and the floors it used, for a caller that reports honesty signals. */
  readonly admission: AdmissionReport;
  readonly pack: MemoryPack;
  readonly now: Date;
  /**
   * The bitemporal vantage point the whole run read from. A listener that writes consults it:
   * inspecting the past is a question, not a use, so it must not stamp `last_accessed` on
   * historical nodes or strengthen edges as though the memory had just fired.
   */
  readonly mode: ReadMode;
};

/**
 * Fired after the pack is persisted and never awaited, so a rejected listener cannot fail
 * a recall that already succeeded. The reinforcement hooks attach here; a listener that does
 * real work owes it to the caller to schedule it rather than run it inline, since a
 * synchronous listener still runs before the pack returns.
 */
export type RecallListener = (completion: RecallCompletion) => void | Promise<void>;

export type RecallDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly sessions: SessionManager;
  readonly provider: Provider;
  readonly config: Config;
  /** Constructed once per process and threaded through, like `SessionManager`. */
  readonly cueCache: CueCache;
  readonly logger: Logger;
  readonly onRecalled?: RecallListener;
};

export type RecallOptions = {
  /** The transport's session identity. `session_id` in the payload overrides it. */
  readonly identity: string;
  readonly now?: Date;
};

const NO_ACTIVATION: ActivationRun = {
  activated: [],
  iterations: 0,
  nodesVisited: 0,
  termination: 'frontier_exhausted',
};

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

type Timed<T> = { readonly value: T; readonly ms: number };

async function timed<T>(run: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const value = await run();
  return { value, ms: round(performance.now() - started) };
}

export function readModeFor(input: RecallInput): ReadMode {
  const validAt = input.as_of === undefined ? undefined : new Date(input.as_of);
  const knownAt = input.knew_at === undefined ? undefined : new Date(input.knew_at);
  if (validAt !== undefined && knownAt !== undefined) {
    return bitemporalAt(validAt, knownAt);
  }
  if (validAt !== undefined) {
    return asOf(validAt);
  }
  if (knownAt !== undefined) {
    return knewAt(knownAt);
  }
  return withCurrency();
}

function admissionFor(config: Config): AdmissionPolicy {
  return {
    vectorFloor: config.recall.vectorAdmissionFloor,
    corroborationFloor: config.recall.corroborationFloor,
    bm25Mode: config.recall.bm25AdmissionMode,
  };
}

function capsFor(config: Config): BucketCaps {
  return {
    facts: config.recall.maxFacts,
    episodes: config.recall.maxEpisodes,
    narratives: config.recall.maxNarratives,
    preferences: config.recall.maxPreferences,
    resonant: config.recall.maxResonant,
  };
}

/** The activated ids no seed strategy found: what the spread reached on its own. */
function arrivalIds(seeds: readonly Seed[], activated: readonly ActivatedNode[]): string[] {
  const known = new Set(seeds.map((seed) => seed.id));
  return activated.map((node) => node.nodeId).filter((id) => !known.has(id));
}

/**
 * Everything the first pass produced, which is what a resonant hit has to be new against. The
 * three sets overlap heavily on a normal run; the union is what makes "found by neither seed
 * nor spread" a property of the id rather than of which stage was asked.
 */
function firstPassIds(
  seeds: readonly Seed[],
  activated: readonly ActivatedNode[],
  items: readonly FusedItem[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const seed of seeds) {
    ids.add(seed.id);
  }
  for (const node of activated) {
    ids.add(node.nodeId);
  }
  for (const item of items) {
    ids.add(item.id);
  }
  return ids;
}

/**
 * Which terminations mean the answer was cut short. `hop_limit` is not one of them: traversal
 * depth is bounded by design, so stopping there is the spread finishing its job. The other two
 * are budgets. `node_budget` measured on 60.2% of recalls against a populated substrate,
 * invisible to every caller.
 */
function truncationFor(termination: ActivationTermination): PackTruncation | undefined {
  if (termination === 'node_budget' || termination === 'max_iterations') {
    return 'activation_budget';
  }
  return undefined;
}

function activationBudget(config: Config): ActivationBudget {
  return {
    ...config.activation,
    maxHops: config.recall.maxHops,
    associationStrength: config.recall.associationStrength,
    maxActivated: config.contextResonance.activationLimit,
  };
}

function notify(deps: RecallDeps, completion: RecallCompletion): void {
  if (deps.onRecalled === undefined) {
    return;
  }
  try {
    const result = deps.onRecalled(completion);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        deps.logger.warn({ err }, 'recall listener failed');
      });
    }
  } catch (err) {
    deps.logger.warn({ err }, 'recall listener failed');
  }
}

/**
 * The `recall` tool. Returns a MemoryPack, always: an empty substrate, a query nothing
 * matches, or a floor that rejects every candidate all produce an explicitly empty pack
 * rather than padding with weak matches, and the pack served is persisted to `last_pack`
 * either way so `aion last` can show exactly what the agent received.
 */
export async function handleRecall(
  deps: RecallDeps,
  input: unknown,
  options: RecallOptions,
): Promise<RecallOutput> {
  const now = options.now ?? new Date();
  const payload = RecallInputSchema.parse(input);
  const mode = readModeFor(payload);

  // Resolved, not created. Recall produces no content, so a read-only session mints no
  // Session node, no INITIATED_BY, no WITHIN_WORKSPACE and no link in the FOLLOWS chain;
  // intake is what brings the node into existence, on the first thing worth remembering.
  const sessionId = deps.sessions.sessionIdFor(payload.session_id ?? options.identity);

  // Fired here rather than awaited here: it depends only on `sessionId` and `mode`, so
  // starting it now lets it run alongside every stage below instead of adding its own
  // latency once the pack is ready to assemble (see the `await` beside `assemblePack`).
  const pendingEnrichmentPromise = pendingEnrichment(deps, sessionId, mode);

  const cues = await timed<CueExtractionResult>(() =>
    extractCues(
      {
        provider: deps.provider,
        model: deps.config.models.cue,
        budgetMs: deps.config.recall.cueBudgetMs,
        cache: deps.cueCache,
        logger: deps.logger,
      },
      {
        query: payload.query,
        ...(payload.context?.summary === undefined ? {} : { summary: payload.context.summary }),
        ...(payload.context?.recent_turns === undefined
          ? {}
          : { recentTurns: payload.context.recent_turns }),
      },
    ),
  );

  const embedded = await timed(() => embedCues(deps, cues.value.cues));

  const selection = await timed(() =>
    selectSeeds(
      { driver: deps.driver, config: deps.config, logger: deps.logger },
      { cues: embedded.value.cues, mode },
    ),
  );
  const seeds = selection.value.seeds;

  // Every rung that fired, in the order the stages run. A pack with no items and no entries
  // here is a real miss; the same pack with a `graph` entry is an outage, and the caller
  // reads the two differently.
  const degradations: Degradation[] = [];
  if (cues.value.degradation !== undefined) {
    degradations.push(cues.value.degradation);
  }
  if (embedded.value.degradation !== undefined) {
    degradations.push(embedded.value.degradation);
  }
  if (selection.value.graphUnavailable) {
    degradations.push({ stage: 'graph', reason: 'unavailable' });
  }

  const adjacency: AdjacencyFetch = (request) => fetchAdjacency(deps.driver, { ...request, mode });
  const activation = await timed(() =>
    seeds.length === 0
      ? Promise.resolve(NO_ACTIVATION)
      : spreadActivation(adjacency, {
          seeds: seeds.map(toActivationSeed),
          budget: activationBudget(deps.config),
        }),
  );

  const fusion = await timed<FusionResult>(async () => {
    const arrivals = arrivalIds(seeds, activation.value.activated);
    const [hydrated, arrivalEvidence] = await Promise.all([
      hydrate(deps, arrivals, mode),
      measureArrivals(deps, arrivals, embedded.value.cues, mode),
    ]);
    const lists = buildRankedLists(deps.config, {
      seeds,
      activated: activation.value.activated,
      hydrated,
      arrivalEvidence,
      byStrategy: selection.value.byStrategy,
    });
    const vectors = await mmrVectors(deps, lists, mode);
    return fuse(lists, {
      rrfConstant: deps.config.search.rrfConstant,
      admission: admissionFor(deps.config),
      reranker: deps.config.search.reranker,
      mmrLambda: deps.config.search.mmrLambda,
      clusterCap: deps.config.recall.clusterCap,
      labelBoosts: labelBoosts(cues.value.cues, deps.config.recall.decisionBoost),
      ...(vectors === undefined ? {} : { vectors }),
    });
  });

  // The second pass, after fusion rather than straight after activation: the items fusion
  // admitted are what the centroid averages and what caps the bucket, and excluding them is
  // also what keeps a resonant discovery out of every other bucket.
  const resonance = await timed<ResonanceResult>(() =>
    resonate(
      { driver: deps.driver, config: deps.config, logger: deps.logger },
      {
        activated: activation.value.activated,
        exclude: firstPassIds(seeds, activation.value.activated, fusion.value.items),
        anchoredIds: new Set(fusion.value.items.map((item) => item.id)),
        mode,
      },
    ),
  );

  // Started as early as the session resolves and awaited only once the pack is ready to
  // assemble, so this honesty field's own graph read never adds serial latency to the call.
  const pendingEnrichmentCount = await pendingEnrichmentPromise;

  const timings: StageTimingsMs = {
    cues: cues.ms,
    embed: embedded.ms,
    seeds: selection.ms,
    activation: activation.ms,
    fusion: fusion.ms,
    resonance: resonance.ms,
  };

  const truncated = truncationFor(activation.value.termination);
  const pack = assemblePack({
    items: fusion.value.items,
    admission: fusion.value.admission,
    caps: capsFor(deps.config),
    tokenBudget: payload.budget?.max_tokens ?? deps.config.recall.tokenBudget,
    cues: cues.value.cues,
    timings,
    ...(degradations.length === 0 ? {} : { degraded: degradations }),
    pendingEnrichment: pendingEnrichmentCount,
    ...(truncated === undefined ? {} : { truncated }),
    restating: queryRestatements(fusion.value.items, {
      floor: deps.config.recall.restatementFloor,
      queryCues: queryCueTexts(cues.value.cues),
    }),
    entityGlossCap: deps.config.recall.entityGlossCap,
    resonant: resonance.value.items,
  });

  saveLastPack(deps.db, sessionId, pack, now.toISOString());
  // The cue stage is 60-95% of recall wall time and the first thing contention takes; a
  // degraded pack is otherwise indistinguishable from a healthy one at the item count.
  recordCueOutcome(deps.db, cues.value.degradation !== undefined);
  // The spirit metric's raw material, read off the assembled pack rather than off the stages
  // that fed it: an item admitted by fusion or resonance and then dropped by a bucket cap or
  // the token budget was never served, and crediting its method would inflate exactly the
  // claim this counter exists to keep honest.
  recordPackMethodCounts(deps.db, packMethods(pack));
  // Cadence's raw material (PRD §3.4): calls per session and the empty-pack rate, from a
  // lifetime total rather than the degraded-rate window above, which trims to the last 500.
  recordRecallOutcome(deps.db, {
    empty: fusion.value.items.length === 0 && resonance.value.items.length === 0,
  });

  deps.logger.info(
    {
      sessionId,
      cues: cues.value.cues.length,
      degraded: degradations.length > 0,
      degradations,
      seeds: seeds.length,
      activated: activation.value.activated.length,
      termination: activation.value.termination,
      items: fusion.value.items.length,
      resonant: resonance.value.items.length,
      // Why the second pass was quiet: a setting, a query nothing anchored, or a substrate
      // whose enrichment has not written the context vectors yet. Absent when it searched.
      resonanceSkipped: resonance.value.skipped,
      // What the floor rejected and the floor it used, so a thin pack is readable from the
      // log without re-running the query.
      admission: fusion.value.admission,
      tokenEstimate: pack.metadata.token_estimate,
      timings,
    },
    'recall served',
  );

  notify(deps, {
    sessionId,
    seeds,
    activated: activation.value.activated,
    items: fusion.value.items,
    admission: fusion.value.admission,
    pack,
    now,
    mode,
  });

  return pack;
}
