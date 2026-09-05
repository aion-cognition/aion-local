import {
  RecallInputSchema,
  type Degradation,
  type MemoryPack,
  type PackTruncation,
  type RecallOutput,
  type StageTimingsMs,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import { arrivalIds, buildRankedLists, firstPassIds, toActivationSeed } from './candidates.js';
import { extractCues, type CueCache, type CueExtractionResult } from './cues.js';
import { triggeredIntentions } from './intentions.js';
import { readModeFor } from './read-mode.js';
import { resonate, type ResonanceResult } from './resonance.js';
import { selectSeeds, type Seed } from './seeds.js';
import {
  embedCues,
  hydrate,
  itemOrigins,
  measureArrivals,
  mmrVectors,
  pendingEnrichment,
  relatedClaims,
} from './stage-reads.js';
import { recordTypedAdmissions } from './typed-admission-ledger.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { roundMs } from '../../infrastructure/errors.js';
import { adjacencyFetchFor } from '../../infrastructure/graph/adjacency.js';
import type { ItemOrigin } from '../../infrastructure/graph/origin-queries.js';
import { isTimeTravel, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { saveLastPack } from '../../infrastructure/sqlite/last-pack.js';
import { recordPackMethodMetrics } from '../../infrastructure/sqlite/method-counters.js';
import { recordRecallOutcome } from '../../infrastructure/sqlite/recall-cadence.js';
import { recordCueOutcome } from '../../infrastructure/sqlite/recall-samples.js';
import { readServedItems, recordServedItems } from '../../infrastructure/sqlite/served-items.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import type { SessionManager } from '../../session/session-manager.js';
import {
  spreadActivation,
  type ActivatedNode,
  type ActivationBudget,
  type ActivationRun,
  type ActivationTermination,
} from '../domain/activation.js';
import type { AdmissionPolicy, AdmissionReport } from '../domain/admission.js';
import { labelBoosts, queryCueTexts, queryRestatements } from '../domain/facts.js';
import { fuse, withSoleMethod, type FusedItem, type FusionResult } from '../domain/fusion.js';
import type { BucketCaps } from '../domain/pack-buckets.js';
import { assemblePack, packMethods } from '../domain/pack.js';
import { servedRecords, suppressedRepeats } from '../domain/session-dedup.js';
import { suppressedOwnSession } from '../domain/session-origin.js';

/**
 * The recall pipeline, in the order its stages run. Cue extraction spends the one generation
 * call recall is allowed, every cue is embedded in a single batch, the five seed strategies
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

/** What a disabled knob and a time-traveled read both hand the origin subtraction. */
const NO_ORIGINS: ReadonlyMap<string, ItemOrigin> = new Map();

const NO_ACTIVATION: ActivationRun = {
  activated: [],
  iterations: 0,
  nodesVisited: 0,
  termination: 'frontier_exhausted',
};

type Timed<T> = { readonly value: T; readonly ms: number };

async function timed<T>(run: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const value = await run();
  return { value, ms: roundMs(performance.now() - started) };
}

function admissionFor(config: Config): AdmissionPolicy {
  return {
    vectorFloor: config.recall.vectorAdmissionFloor,
    corroborationFloor: config.recall.corroborationFloor,
    bm25Mode: config.recall.bm25AdmissionMode,
    typedAdmissionEnabled: config.recall.typedAdmission,
    typedAdmissionActivationFloor: config.recall.typedAdmissionActivationFloor,
  };
}

function capsFor(config: Config): BucketCaps {
  return {
    facts: config.recall.maxFacts,
    episodes: config.recall.maxEpisodes,
    narratives: config.recall.maxNarratives,
    intentions: config.recall.maxIntentions,
    preferences: config.recall.maxPreferences,
    resonant: config.recall.maxResonant,
  };
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
  const mode = readModeFor(payload, {
    now,
    expiryAnnotation: deps.config.temporal.expiryAnnotation,
  });

  // Resolved, not created. Recall produces no content, so a read-only session mints no
  // Session node, no INITIATED_BY, no WITHIN_WORKSPACE and no link in the FOLLOWS chain;
  // intake is what brings the node into existence, on the first thing worth remembering.
  const sessionId = deps.sessions.sessionIdFor(payload.session_id ?? options.identity);

  // Fired here rather than awaited here: it depends only on `sessionId` and `mode`, so
  // starting it now lets it run alongside every stage below instead of adding its own
  // latency once the pack is ready to assemble (see the `await` beside `assemblePack`).
  const pendingEnrichmentPromise = pendingEnrichment(deps, sessionId, mode);

  // Redacted before the cue model or the embedder sees any of it: both are inference calls
  // over caller-supplied text, and a secret-shaped token in the query is the same leak surface
  // intake already closes for a stored payload.
  const { value: cueInput } = redactPayload(
    {
      query: payload.query,
      ...(payload.context?.summary === undefined ? {} : { summary: payload.context.summary }),
      ...(payload.context?.recent_turns === undefined
        ? {}
        : { recentTurns: payload.context.recent_turns }),
    },
    deps.config.redaction.entropyThreshold,
  );

  const cues = await timed<CueExtractionResult>(() =>
    extractCues(
      {
        provider: deps.provider,
        model: deps.config.models.cue,
        budgetMs: deps.config.recall.cueBudgetMs,
        cache: deps.cueCache,
        logger: deps.logger,
      },
      cueInput,
    ),
  );

  const embedded = await timed(() => embedCues(deps, cues.value.cues));

  const selection = await timed(() =>
    selectSeeds(
      { driver: deps.driver, config: deps.config, logger: deps.logger },
      { cues: embedded.value.cues, mode },
    ),
  );
  const { seeds } = selection.value;

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

  const { associationStrength, adjacencyTopK } = deps.config.recall;
  const adjacency = adjacencyFetchFor(deps.driver, mode, associationStrength, adjacencyTopK);
  const activation = await timed(() =>
    seeds.length === 0
      ? Promise.resolve(NO_ACTIVATION)
      : spreadActivation(adjacency, {
          seeds: seeds.map(toActivationSeed),
          budget: activationBudget(deps.config),
        }),
  );
  const admissionPolicy = admissionFor(deps.config);
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
      admission: admissionPolicy,
      reranker: deps.config.search.reranker,
      mmrLambda: deps.config.search.mmrLambda,
      clusterCap: deps.config.recall.clusterCap,
      clusterCosineThreshold: deps.config.recall.clusterCosineThreshold,
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

  // The third way in, after the second pass because it reads the centroid that pass computed.
  // Deterministic throughout: one bounded read and three comparisons per row.
  const intentions = await triggeredIntentions(deps, {
    activated: activation.value.activated,
    resonance: resonance.value,
    served: [...fusion.value.items, ...resonance.value.items],
    mode,
    now,
  });

  // Started as early as the session resolves and awaited only once the pack is ready to
  // assemble, so this honesty field's own graph read never adds serial latency to the call.
  const pendingEnrichmentCount = await pendingEnrichmentPromise;

  const candidates = new Map<string, FusedItem>();
  for (const item of [...fusion.value.items, ...resonance.value.items, ...intentions.items]) {
    candidates.set(item.id, item);
  }

  // Both subtractions are exempt from a time-traveled read: asking what the substrate held last
  // month is a question about the past rather than a re-serve, and reading back what a session
  // itself wrote is the whole point of asking.
  const dedup = deps.config.recall.sessionDedup && !isTimeTravel(mode);
  const ownFilter = deps.config.recall.ownSessionFilter && !isTimeTravel(mode);

  // Both run after the second pass. Claims are asked only about what resonance surfaced, and a
  // pack whose resonant bucket holds no raw turn issues no query at all; origins are asked about
  // the whole candidate set, which is final only now. Neither needs the other's answer, so the
  // pair costs one round trip rather than two.
  const [claims, origins] = await Promise.all([
    relatedClaims(deps, resonance.value.items, mode),
    ownFilter ? itemOrigins(deps, [...candidates.keys()], sessionId, mode) : NO_ORIGINS,
  ]);

  const timings: StageTimingsMs = {
    cues: cues.ms,
    embed: embedded.ms,
    seeds: selection.ms,
    activation: activation.ms,
    fusion: fusion.ms,
    resonance: resonance.ms,
  };

  // The two serving-layer subtractions, applied once the candidate set is final so that nothing
  // above them measures a smaller set: reinforcement, access tracking and the method counters
  // all still see everything fusion admitted.
  //
  // Origin decides first, and what it withholds leaves no served row: the session never read
  // those items, so a later recall must be free to offer them the moment they stop being its own
  // record. Dedup then judges what is left.
  const ranked = [...candidates.values()];
  const suppressedOwn = suppressedOwnSession({ items: ranked, origins, relatedClaims: claims });
  const suppressed = dedup
    ? suppressedRepeats(
        ranked.filter((item) => !suppressedOwn.has(item.id)),
        readServedItems(deps.db, sessionId),
      )
    : new Set<string>();

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
    intentions: intentions.items,
    ...(claims.size === 0 ? {} : { relatedClaims: claims }),
    suppressed,
    suppressedOwn,
  });

  saveLastPack(deps.db, sessionId, pack, now.toISOString(), {
    ...(payload.as_of === undefined ? {} : { asOf: payload.as_of }),
    ...(payload.knew_at === undefined ? {} : { knewAt: payload.knew_at }),
  });
  recordTypedAdmissions(deps.db, sessionId, now, mode, fusion.value.items, admissionPolicy);
  // A time-traveled read records nothing: it never suppresses, so recording what it served
  // would make a historical inspection decide what the present-day pack may repeat.
  if (dedup) {
    recordServedItems(
      deps.db,
      sessionId,
      servedRecords(pack, suppressed, candidates),
      now.toISOString(),
    );
  }
  // The cue stage is 60-95% of recall wall time and the first thing contention takes; a
  // degraded pack is otherwise indistinguishable from a healthy one at the item count.
  recordCueOutcome(deps.db, cues.value.degradation !== undefined);
  // Read off the assembled pack, not the stages that fed it: a bucket cap or the token budget can
  // still drop what fusion admitted, and crediting a dropped item's method would lie about the
  // spirit metric. The leg stats widen that to every contributing method, not just the one the
  // rationale names; resonance is folded in as a sole find, since it skips fusion's merge.
  recordPackMethodMetrics(
    deps.db,
    packMethods(pack),
    withSoleMethod(fusion.value.methodStats, 'resonance', resonance.value.items.length),
  );
  // Cadence's raw material: calls per session and the empty-pack rate, from a lifetime
  // total rather than the degraded-rate window above, which trims to the last 500.
  recordRecallOutcome(deps.db, {
    empty:
      fusion.value.items.length === 0 &&
      resonance.value.items.length === 0 &&
      intentions.items.length === 0,
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
      // What the substrate volunteered, and why it volunteered nothing when it did not.
      intentions: intentions.items.length,
      intentionsSkipped: intentions.skipped,
      // What the wire dropped that cognition still counted, so a pack that shrank mid-session
      // reads as the subtraction rather than as retrieval going quiet.
      suppressedRepeats: suppressed.size,
      // The other half of the same reading: how much of the answer was this session quoting
      // itself, which is a number worth watching as the conversation gets long.
      suppressedOwn: suppressedOwn.size,
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
