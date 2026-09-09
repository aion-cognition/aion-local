import {
  RecallInputSchema,
  type Degradation,
  type RecallOutput,
  type StageTimingsMs,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import { arrivalIds, buildRankedLists, firstPassIds, toActivationSeed } from './candidates.js';
import type { CheckedRead } from './coverage-checker.js';
import { extractCues, type CueCache, type CueExtractionResult } from './cues.js';
import { triggeredIntentions } from './intentions.js';
import { readModeFor } from './read-mode.js';
import { emitRecallTrace, notifyRecalled, type RecallListener } from './recall-observers.js';
import { activationBudget, admissionFor, capsFor, truncationFor } from './recall-policy.js';
import { readEvidence, resolvedView } from './resolved-view.js';
import { resonate, type ResonanceResult } from './resonance.js';
import { selectSeeds } from './seeds.js';
import {
  commitServingEffects,
  servingEffects,
  withCoverage,
  type RecallCommit,
} from './serving-effects.js';
import {
  embedCues,
  hydrate,
  measureArrivals,
  mmrVectors,
  pendingEnrichment,
  relatedClaims,
  restatedClaimPairs,
} from './stage-reads.js';
import { ownershipNominationHint } from '../../evidence/application/ownership.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { roundMs } from '../../infrastructure/errors.js';
import { adjacencyFetchFor } from '../../infrastructure/graph/adjacency.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readServedItems } from '../../infrastructure/sqlite/served-items.js';
import { redactPayload } from '../../redaction/deep-walk.js';
import type { SessionManager } from '../../session/session-manager.js';
import { spreadActivation, type ActivationRun } from '../domain/activation.js';
import { labelBoosts, queryCueTexts, queryRestatements } from '../domain/facts.js';
import { fuse, type FusedItem, type FusionResult } from '../domain/fusion.js';
import type { PackDecision } from '../domain/pack-decisions.js';
import { foldableClaims } from '../domain/pack-duplicates.js';
import { assemblePack } from '../domain/pack.js';
import type { RecallTraceObserver } from '../domain/recall-trace.js';
import { emittedPackIds, suppressedRepeats } from '../domain/session-dedup.js';
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

export type { RecallCompletion, RecallListener } from './recall-observers.js';

export type RecallDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly sessions: SessionManager;
  readonly provider: Provider;
  readonly config: Config;
  /** Constructed once per process and threaded through, like `SessionManager`. */
  readonly cueCache: CueCache;
  /**
   * The certified evidence surface, supplied by an entry point that also checked coverage. With
   * both the pack reads its provenance and ownership through the resolver; with neither it reads
   * them off the graph, which is what it did before the resolver existed.
   */
  readonly resolver?: EvidenceResolver;
  readonly logger: Logger;
  readonly onRecalled?: RecallListener;
  /**
   * A diagnostic reader of the stages this run went through. Absent everywhere but a
   * comparison run: it issues no query and no provider call, and what it records is read off
   * values the run already produced.
   */
  readonly onTrace?: RecallTraceObserver;
};

export type RecallOptions = {
  /** The transport's session identity. `session_id` in the payload overrides it. */
  readonly identity: string;
  readonly now?: Date;
  /** The coverage decision this request was checked under, when an entry point took one. */
  readonly checked?: CheckedRead;
  readonly commit?: RecallCommit;
};

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
  const payload = RecallInputSchema.parse(input);
  // One reading, not two. A checked read was judged against a clock and a mode the checker
  // already pinned, and re-deriving either here would let the answer be computed under a
  // vantage point the coverage decision never saw.
  const now = options.checked?.context.now ?? options.now ?? new Date();
  const mode =
    options.checked?.context.mode ??
    readModeFor(payload, {
      now,
      expiryAnnotation: deps.config.temporal.expiryAnnotation,
    });

  // Resolved, not created. Recall produces no content, so a read-only session mints no
  // Session node, no INITIATED_BY, no WITHIN_WORKSPACE and no link in the FOLLOWS chain;
  // intake is what brings the node into existence, on the first thing worth remembering.
  const sessionId = deps.sessions.sessionIdFor(payload.session_id ?? options.identity);

  // A compaction summarizes the caller's own transcript, and nothing here can tell which of
  // what it served survived that summary. Leaving the served-items ledger untouched risks
  // withholding text the caller no longer holds. The caller names the epoch itself; recall
  // has no other way to learn one happened.
  //
  // Staged rather than done here. The run computes against an empty served set in memory and the
  // durable rows go only at the successful-read boundary, so a read that then refuses does not
  // take the caller's holdings with it.
  const resetDelivery = payload.reset_delivery_suppression === true;

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

  // Both origin-aware steps read one setting and one exemption: a time-traveled read is asking
  // what the substrate held, so it neither discounts nor subtracts the asker's own record.
  const ownFilter = deps.config.recall.ownSessionFilter && !isTimeTravel(mode);

  // The bound the pre-limit ordering trusts a stored ownership summary up to, read before
  // nomination runs. It takes no guard, recovers no receipt and waits for nothing: an absent or
  // stale bound costs the ordering its discount and never costs an answer a memory.
  const hint = ownFilter ? ownershipNominationHint(deps.db) : undefined;

  const selection = await timed(() =>
    selectSeeds(
      { driver: deps.driver, config: deps.config, logger: deps.logger },
      {
        cues: embedded.value.cues,
        mode,
        ...(hint === undefined ? {} : { ownership: { ...hint, sessionId } }),
      },
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

  // All three run after the second pass, against the candidate set, which is final only now. A
  // pack holding no raw turn issues no claim query at all. None of the three needs another's
  // answer, so they cost one round trip rather than three.
  const ranked = [...candidates.values()];
  const ids = [...candidates.keys()];
  const [claims, reading, restated] = await Promise.all([
    relatedClaims(deps, ranked, mode),
    readEvidence(deps, {
      ids,
      sessionId,
      mode,
      attribute: ownFilter,
      ...(options.checked === undefined ? {} : { context: options.checked.context }),
    }),
    restatedClaimPairs(deps, ids, mode),
  ]);
  // One view per attempt. Suppression, the fold, rendering and the holdings record all read it,
  // so nothing below can decide from a reading a later stage contradicts.
  const view = resolvedView({ reading, relatedClaims: claims, sessionId, attribute: ownFilter });

  const timings: StageTimingsMs = {
    cues: cues.ms,
    embed: embedded.ms,
    seeds: selection.ms,
    activation: activation.ms,
    fusion: fusion.ms,
    resonance: resonance.ms,
  };

  // The two serving-layer subtractions, applied once the candidate set is final so that nothing
  // above them measures a smaller set: ranking, the admission report and the method counters all
  // still see everything fusion admitted. What they cut is cut from exposure too, since exposure
  // is read off the assembled pack below.
  //
  // Origin decides first, and what it withholds leaves no served row: the session never read
  // those items, so a later recall must be free to offer them the moment they stop being its own
  // record. Dedup then judges what is left.
  const suppressedOwn = suppressedOwnSession({ items: ranked, view });
  // A staged reset computes against an empty served set: the durable rows are still there, and
  // this call has to answer as though the session had been served nothing.
  const served =
    dedup && !resetDelivery ? readServedItems(deps.db, sessionId) : new Map<string, string>();
  const suppressed = dedup
    ? suppressedRepeats(
        ranked.filter((item) => !suppressedOwn.has(item.id)),
        served,
        view,
      )
    : new Set<string>();
  // The third subtraction is only made eligible here. Assembly decides it, because an item the
  // other two already cut, or one the budget turns away, is not a copy anybody read and so
  // cannot stand in for another.
  const foldable = foldableClaims({ items: ranked, pairs: restated, view });

  const truncated = truncationFor(activation.value.termination);
  // Recorded where assembly decides, and only when somebody is watching: a fold, a bucket cap
  // and the token budget are three different answers, and only this call site knows which.
  const assemblyDecisions: PackDecision[] = [];
  const pack = assemblePack({
    ...(deps.onTrace === undefined
      ? {}
      : {
          onDecision: (decision: PackDecision) => {
            assemblyDecisions.push(decision);
          },
        }),
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
    ...(view.relatedClaims.size === 0 ? {} : { relatedClaims: view.relatedClaims }),
    ...(view.provenance.size === 0 ? {} : { provenance: view.provenance }),
    historical: isTimeTravel(mode),
    suppressed,
    suppressedOwn,
    foldable,
  });

  // What the answer covers, attached to the pack the caller receives rather than to the one
  // assembly measured: coverage moves no bucket and costs no token budget.
  const answer =
    options.checked === undefined ? pack : withCoverage(pack, options.checked.coverage, view);
  const emitted = emittedPackIds(pack);

  // Every successful-read write in one place and one transaction, reset first. The boundary that
  // checks the coverage contract takes exactly these two callbacks; until an entry point supplies
  // one they run here, which is where they ran before.
  const effects = servingEffects({
    sessionId,
    now,
    mode,
    pack: answer,
    temporal: {
      ...(payload.as_of === undefined ? {} : { asOf: payload.as_of }),
      ...(payload.knew_at === undefined ? {} : { knewAt: payload.knew_at }),
    },
    admission: { policy: admissionPolicy, items: fusion.value.items },
    candidates,
    view,
    suppressed,
    dedup,
    cueDegraded: cues.value.degradation !== undefined,
    methodStats: fusion.value.methodStats,
    resonantCount: resonance.value.items.length,
    empty:
      fusion.value.items.length === 0 &&
      resonance.value.items.length === 0 &&
      intentions.items.length === 0,
    resetDelivery,
  });
  const disposition = await commitServingEffects(deps.db, effects, options.commit);

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
      // And the third: one assertion the substrate holds twice, printed once. Read off the
      // pack, because eligibility is decided here and the withholding is decided by assembly.
      suppressedDuplicates: pack.metadata.suppressed_duplicates ?? 0,
      // What the caller was handed, which is the number every exposure write is charged
      // against. Beside the candidate count it reads as how much of retrieval reached the wire.
      emitted: emitted.size,
      // Why the second pass was quiet: a setting, a query nothing anchored, or a substrate
      // whose enrichment has not written the context vectors yet. Absent when it searched.
      resonanceSkipped: resonance.value.skipped,
      // What the floor rejected and the floor it used, so a thin pack is readable from the
      // log without re-running the query.
      admission: fusion.value.admission,
      tokenEstimate: pack.metadata.token_estimate,
      timings,
    },
    disposition === 'served' ? 'recall served' : 'recall withheld',
  );

  const retrieved = [...candidates.keys()];
  emitRecallTrace(deps.onTrace, deps.logger, deps.config, {
    sessionId,
    query: payload.query,
    mode,
    sampledAt: now,
    byStrategy: selection.value.byStrategy,
    activation: activation.value,
    fused: fusion.value.items,
    admission: fusion.value.admission,
    preAssembly: retrieved,
    withheldOwn: suppressedOwn,
    withheldRepeat: suppressed,
    foldEligible: foldable,
    foldedCount: pack.metadata.suppressed_duplicates ?? 0,
    assemblyDecisions,
    emitted,
  });

  // Nothing the caller never received is reinforced, stamped or counted as exposure. The
  // boundary is what knows: a refused completion means this answer was not handed over.
  if (disposition === 'served') {
    notifyRecalled(deps.onRecalled, deps.logger, {
      sessionId,
      seeds,
      activated: activation.value.activated,
      retrieved,
      emitted,
      admission: fusion.value.admission,
      pack: answer,
      now,
      mode,
    });
  }

  return answer;
}
