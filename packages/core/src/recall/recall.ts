import {
  RecallInputSchema,
  type Cue,
  type MemoryPack,
  type RecallInput,
  type RecallOutput,
  type StageTimingsMs,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import type { Config } from '../config/schema.js';
import { fetchAdjacency } from '../graph/adjacency.js';
import { asOf, bitemporalAt, knewAt, withCurrency, type ReadMode } from '../graph/read-modes.js';
import { contentVectors, nodeCandidates, type SeedCandidate } from '../graph/seed-queries.js';
import type { Logger } from '../logging/logger.js';
import type { Provider, Vector } from '../providers/types.js';
import type { SessionManager } from '../session/session-manager.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { saveLastPack } from '../sqlite/last-pack.js';
import {
  spreadActivation,
  type ActivatedNode,
  type ActivationBudget,
  type ActivationRun,
  type AdjacencyFetch,
} from './activation.js';
import { buildRankedLists, toActivationSeed } from './candidates.js';
import { extractCues, type CueCache, type CueExtractionResult } from './cues.js';
import { fuse, type FusedItem, type RankedList } from './fusion.js';
import { assemblePack, type BucketCaps } from './pack.js';
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

/**
 * One batched `embed` for every cue, including the degradation ladder's raw-query cue.
 * An embedding outage costs recall its vector leg and nothing else: BM25, exact entity
 * resolution, recency, and traversal all run on cue text or on graph structure, which is
 * PRD §10's deeper rung of degradation.
 */
async function embedCues(
  deps: RecallDeps,
  cues: readonly Cue[],
): Promise<readonly SeedCue[]> {
  if (cues.length === 0) {
    return [];
  }
  let vectors: readonly Vector[] = [];
  try {
    vectors = await deps.provider.embed(cues.map((cue) => cue.text));
  } catch (err) {
    deps.logger.warn({ err, model: deps.config.models.embed }, 'cue embedding failed');
    return cues;
  }
  return cues.map((cue, index) => {
    const vector = vectors[index];
    if (vector === undefined || vector.length === 0) {
      return cue;
    }
    return { ...cue, vector };
  });
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
      { cues: embedded.value, mode },
    ),
  );
  const seeds = selection.value.seeds;

  const adjacency: AdjacencyFetch = (request) => fetchAdjacency(deps.driver, { ...request, mode });
  const activation = await timed(() =>
    seeds.length === 0
      ? Promise.resolve(NO_ACTIVATION)
      : spreadActivation(adjacency, {
          seeds: seeds.map(toActivationSeed),
          budget: activationBudget(deps.config),
        }),
  );

  const fusion = await timed(async () => {
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
      minRelevance: deps.config.recall.minRelevance,
      reranker: deps.config.search.reranker,
      mmrLambda: deps.config.search.mmrLambda,
      ...(vectors === undefined ? {} : { vectors }),
    });
  });

  const timings: StageTimingsMs = {
    cues: cues.ms,
    embed: embedded.ms,
    seeds: selection.ms,
    activation: activation.ms,
    fusion: fusion.ms,
  };

  const pack = assemblePack({
    items: fusion.value,
    caps: capsFor(deps.config),
    tokenBudget: payload.budget?.max_tokens ?? deps.config.recall.tokenBudget,
    cues: cues.value.cues,
    timings,
    ...(cues.value.degradation === undefined ? {} : { degraded: cues.value.degradation }),
  });

  saveLastPack(deps.db, sessionId, pack, now.toISOString());

  deps.logger.info(
    {
      sessionId,
      cues: cues.value.cues.length,
      degraded: cues.value.degraded,
      seeds: seeds.length,
      activated: activation.value.activated.length,
      termination: activation.value.termination,
      items: fusion.value.length,
      tokenEstimate: pack.metadata.token_estimate,
      timings,
    },
    'recall served',
  );

  notify(deps, {
    sessionId,
    seeds,
    activated: activation.value.activated,
    items: fusion.value,
    pack,
    now,
    mode,
  });

  return pack;
}
