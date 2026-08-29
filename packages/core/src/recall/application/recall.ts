import {
  RecallInputSchema,
  type Cue,
  type Degradation,
  type MemoryPack,
  type RecallInput,
  type RecallOutput,
  type StageTimingsMs,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import { fetchAdjacency } from '../../infrastructure/graph/adjacency.js';
import { listSessionEpisodeIds } from '../../infrastructure/graph/episodes.js';
import { asOf, bitemporalAt, knewAt, withCurrency, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import { contentVectors, nodeCandidates, type SeedCandidate } from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import type { SessionManager } from '../../session/session-manager.js';
import { isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { orchestratorLedgerKey } from '../../reflection/application/orchestrator.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { saveLastPack } from '../../infrastructure/sqlite/last-pack.js';
import {
  spreadActivation,
  type ActivatedNode,
  type ActivationBudget,
  type ActivationRun,
  type AdjacencyFetch,
} from '../domain/activation.js';
import { buildRankedLists, toActivationSeed } from './candidates.js';
import { extractCues, type CueCache, type CueExtractionResult } from './cues.js';
import type { AdmissionPolicy, AdmissionReport } from '../domain/admission.js';
import { fuse, type FusedItem, type FusionResult, type RankedList } from '../domain/fusion.js';
import { assemblePack, type BucketCaps } from '../domain/pack.js';
import { selectSeeds, type Seed, type SeedCue } from './seeds.js';

/**
 * PRD §6, whitepaper §5: the recall pipeline, in the order its stages run. Cue extraction
 * spends the one generation call recall is allowed (PRD §10), every cue is embedded in a
 * single batch, the four seed strategies run, activation spreads from what they found,
 * fusion ranks the union, and the pack is assembled and persisted.
 *
 * `as_of` / `knew_at` bind one read mode for the whole run: currency is judged from a
 * single vantage point, so seeds, traversal, and hydration cannot disagree about what was
 * true when.
 */

export type RecallCompletion = {
  readonly sessionId: string;
  readonly seeds: readonly Seed[];
  /** Whitepaper §5.8's co-activated set, seeds included, for the reinforcement side effects. */
  readonly activated: readonly ActivatedNode[];
  readonly items: readonly FusedItem[];
  /** What the admission gate dropped and the floors it used, for a caller that reports honesty signals. */
  readonly admission: AdmissionReport;
  readonly pack: MemoryPack;
  readonly now: Date;
  /**
   * The bitemporal vantage point the whole run read from. A listener that writes consults it:
   * inspecting the past is a question, not a use, so it must not stamp `last_accessed` on
   * historical nodes or strengthen edges as though the memory had just fired (PRD §5.5).
   */
  readonly mode: ReadMode;
};

/**
 * Fired after the pack is persisted and never awaited, so a rejected listener cannot fail
 * a recall that already succeeded. Whitepaper §5.8's reinforcement hooks attach here; a
 * listener that does real work owes it to the caller to schedule it rather than run it
 * inline, since a synchronous listener still runs before the pack returns.
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
  /** The transport's session identity. `session_id` in the payload overrides it (PRD §3.3). */
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

type EmbeddedCues = {
  readonly cues: readonly SeedCue[];
  readonly degradation?: Degradation;
};

/**
 * One batched `embed` for every cue, including the degradation ladder's raw-query cue.
 * An embedding outage costs recall its vector leg and nothing else: BM25, exact entity
 * resolution, recency, and traversal all run on cue text or on graph structure, which is
 * PRD §10's deeper rung of degradation. The rung is reported, because a pack answered
 * without its semantic leg is a thinner answer than the caller has any other way to see.
 */
async function embedCues(deps: RecallDeps, cues: readonly Cue[]): Promise<EmbeddedCues> {
  if (cues.length === 0) {
    return { cues: [] };
  }
  let vectors: readonly Vector[] = [];
  try {
    vectors = await deps.provider.embed(cues.map((cue) => cue.text));
  } catch (err) {
    deps.logger.warn({ err, model: deps.config.models.embed }, 'cue embedding failed');
    return { cues, degradation: { stage: 'embed', reason: 'model_error' } };
  }
  return {
    cues: cues.map((cue, index) => {
      const vector = vectors[index];
      if (vector === undefined || vector.length === 0) {
        return cue;
      }
      return { ...cue, vector };
    }),
  };
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

async function mmrVectors(
  deps: RecallDeps,
  lists: readonly RankedList[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, Vector> | undefined> {
  if (deps.config.search.reranker !== 'mmr') {
    return undefined;
  }
  const ids = new Set<string>();
  for (const list of lists) {
    for (const candidate of list.candidates) {
      ids.add(candidate.id);
    }
  }
  const rows = await contentVectors(deps.driver, { ids: [...ids], mode });
  return new Map(rows.map((row) => [row.id, row.vector]));
}

/** Hydrates the activated ids no seed strategy already carried content for. */
async function hydrate(
  deps: RecallDeps,
  seeds: readonly Seed[],
  activated: readonly ActivatedNode[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, SeedCandidate>> {
  const known = new Set(seeds.map((seed) => seed.id));
  const ids = activated.map((node) => node.nodeId).filter((id) => !known.has(id));
  const rows = await nodeCandidates(deps.driver, { ids, mode });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The calling session's own episodes with no orchestrator ledger key (EX-11): stored and
 * findable by raw text, but not yet reachable by entity resolution, traversal, or context
 * vectors. Best-effort — a failure here costs the pack one honesty field, never the recall
 * itself, so it is caught and logged rather than allowed to fail the call.
 */
async function pendingEnrichment(deps: RecallDeps, sessionId: string, mode: ReadMode): Promise<number> {
  try {
    const episodeIds = await listSessionEpisodeIds(deps.driver, sessionId, mode);
    let count = 0;
    for (const episodeId of episodeIds) {
      if (!isLedgerApplied(deps.db, orchestratorLedgerKey(episodeId))) {
        count += 1;
      }
    }
    return count;
  } catch (err) {
    deps.logger.warn({ err, sessionId }, 'pending-enrichment count failed; omitted from the pack');
    return 0;
  }
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
 * PRD §3.1's `recall` tool. Returns a MemoryPack, always: an empty substrate, a query
 * nothing matches, or a floor that rejects every candidate all produce an explicitly empty
 * pack rather than padding with weak matches, and the pack served is persisted to
 * `last_pack` either way so `aion last` can show exactly what the agent received.
 */
export async function handleRecall(
  deps: RecallDeps,
  input: unknown,
  options: RecallOptions,
): Promise<RecallOutput> {
  const now = options.now ?? new Date();
  const payload = RecallInputSchema.parse(input);
  const mode = readModeFor(payload);

  const { sessionId } = await deps.sessions.ensureSession({
    identity: payload.session_id ?? options.identity,
    now,
  });

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
    const hydrated = await hydrate(deps, seeds, activation.value.activated, mode);
    const lists = buildRankedLists(deps.config, {
      seeds,
      activated: activation.value.activated,
      hydrated,
      byStrategy: selection.value.byStrategy,
    });
    const vectors = await mmrVectors(deps, lists, mode);
    return fuse(lists, {
      rrfConstant: deps.config.search.rrfConstant,
      admission: admissionFor(deps.config),
      reranker: deps.config.search.reranker,
      mmrLambda: deps.config.search.mmrLambda,
      clusterCap: deps.config.recall.clusterCap,
      ...(vectors === undefined ? {} : { vectors }),
    });
  });

  // Started as early as the session resolves and awaited only once the pack is ready to
  // assemble, so this honesty field's own graph read never adds serial latency to the call.
  const pendingEnrichmentCount = await pendingEnrichmentPromise;

  const timings: StageTimingsMs = {
    cues: cues.ms,
    embed: embedded.ms,
    seeds: selection.ms,
    activation: activation.ms,
    fusion: fusion.ms,
  };

  const pack = assemblePack({
    items: fusion.value.items,
    caps: capsFor(deps.config),
    tokenBudget: payload.budget?.max_tokens ?? deps.config.recall.tokenBudget,
    cues: cues.value.cues,
    timings,
    ...(degradations.length === 0 ? {} : { degraded: degradations }),
    pendingEnrichment: pendingEnrichmentCount,
  });

  saveLastPack(deps.db, sessionId, pack, now.toISOString());

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
