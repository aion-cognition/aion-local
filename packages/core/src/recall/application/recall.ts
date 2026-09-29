import {
  RecallInputSchema,
  type Degradation,
  type RecallOutput,
  type StageTimingsMs,
} from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import { assessedFor, assessmentReach, runAssessment, withoutAssessment } from './assessment.js';
import { arrivalIds, buildRankedLists, firstPassIds, toActivationSeed } from './candidates.js';
import type { CheckedRead } from './coverage-checker.js';
import { recallCues, type CueCache, type CueExtractionResult } from './cues.js';
import { discloseFamilyGaps, revalidateFamilyPolicy } from './family-serving-policy.js';
import { triggeredIntentions } from './intentions.js';
import { readModeFor } from './read-mode.js';
import {
  emitRecallTrace,
  logServed,
  notifyRecalled,
  type RecallListener,
} from './recall-observers.js';
import { activationBudget, admissionFor, capsFor, truncationFor } from './recall-policy.js';
import { readEvidence, resolvedView } from './resolved-view.js';
import { resonate, type ResonanceResult } from './resonance.js';
import { selectSeeds } from './seeds.js';
import { serveFrom, type ServedAnswer, type ServingAssembly } from './serving-assembly.js';
import {
  boundaryIssues,
  commitServingEffects,
  servedReading,
  servingEffects,
  withCoverage,
  type RecallCommit,
} from './serving-effects.js';
import {
  embedCues,
  hydrate,
  measureArrivals,
  mmrVectors,
  sessionObligations,
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
import type { RecallTraceObserver } from '../domain/recall-trace.js';
import { uncertifiedThroughout, type ResolvedEvidenceView } from '../domain/resolved-view.js';
import { emittedPackIds } from '../domain/session-dedup.js';

/**
 * The recall pipeline, in the order its stages run. The caller's query (or, in the `cues` mode,
 * the cues a model extracted from it) is embedded in a single batch, the five seed strategies
 * run, activation spreads from what they found, fusion ranks the union, context resonance makes
 * its second pass over what activation reached, and the evidence is read. In the `assess` mode
 * the recall model then chooses what helps from what was found; that is the one generation call
 * recall is allowed. The pack is assembled and persisted.
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
  bridgeLegs: [],
  hubPenalty: { hops: 0, inhibitedHops: 0, totalPenalty: 0, minPenalty: 1 },
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
  // One reading, not two: a checked read carries the clock and the mode the checker pinned, and
  // re-deriving either here would answer from a vantage point the coverage decision never saw.
  const now = options.checked?.context.now ?? options.now ?? new Date();
  const mode =
    options.checked?.context.mode ??
    readModeFor(payload, { now, expiryAnnotation: deps.config.temporal.expiryAnnotation });

  // Resolved, not created. Recall produces no content, so a read-only session mints no Session
  // node, no INITIATED_BY, WITHIN_WORKSPACE or FOLLOWS link; intake mints one on the first thing
  // worth remembering.
  const sessionId = deps.sessions.sessionIdFor(payload.session_id ?? options.identity);

  // A compaction summarizes the caller's transcript and nothing here can tell what survived it,
  // so the caller names the epoch itself. Staged rather than done here: the run computes against
  // an empty served set in memory, and the durable rows go only at the successful-read boundary,
  // so a read that then refuses does not take the caller's holdings with it.
  const resetDelivery = payload.reset_delivery_suppression === true;

  // One indexed read over the durable records, so it costs a point read rather than a graph
  // walk and answers the same for an evicted source as for a resident one.
  const obligations = sessionObligations(deps, sessionId);

  // Redacted before the recall model or the embedder sees any of it: both are inference calls over
  // caller-supplied text, the same leak surface intake already closes for a stored payload.
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

  const cues = await timed<CueExtractionResult>(() => recallCues(deps, cueInput));

  const embedded = await timed(() => embedCues(deps, cues.value.cues));

  // Both origin-aware steps read one setting and two exemptions: a time-traveled read is asking
  // what the substrate held, and a reset is a caller saying it no longer holds what it captured.
  const ownFilter = deps.config.recall.ownSessionFilter && !isTimeTravel(mode) && !resetDelivery;

  // The bound the pre-limit ordering trusts a stored ownership summary up to. Takes no guard,
  // recovers no receipt: an absent or stale bound costs the ordering its discount, never a memory.
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

  // Every rung that fired, in the order the stages run: a pack with a `graph` entry here is an
  // outage, and the same empty pack with no entries is a real miss, read differently by the caller.
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
      pathStrengthSlots: deps.config.recall.pathStrengthSlots,
      labelBoosts: labelBoosts(cues.value.cues, deps.config.recall.decisionBoost),
      ...(vectors === undefined ? {} : { vectors }),
    });
  });

  // After fusion so it can exclude what the first pass already produced, not because it needs
  // fusion's admission: the centroid averages the activated set minus structural plumbing and
  // whatever no cue-seeded path reached, so a query fusion answers with nothing can still get a
  // real second way in.
  const resonance = await timed<ResonanceResult>(() =>
    resonate(
      { driver: deps.driver, config: deps.config, logger: deps.logger },
      {
        activated: activation.value.activated,
        exclude: firstPassIds(seeds, activation.value.activated, fusion.value.items),
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
  // What the floors refused, read under the same evidence as the rest so the assessment can be
  // shown it; bounded by the pack's own slots, since no more than that could be shown.
  const reach = assessmentReach(deps.config, fusion.value.refused, candidates);
  const readIds = [...ids, ...reach.items.map((item) => item.id)];
  const [claims, reading, restated] = await Promise.all([
    relatedClaims(deps, [...ranked, ...reach.items], mode),
    readEvidence(deps, {
      ids: readIds,
      sessionId,
      mode,
      attribute: ownFilter,
      ...(options.checked === undefined ? {} : { context: options.checked.context }),
    }),
    restatedClaimPairs(deps, readIds, mode),
  ]);
  // One view per attempt. Suppression, the fold, rendering and the holdings record all read it,
  // so nothing below can decide from a reading a later stage contradicts.
  const view = discloseFamilyGaps(
    resolvedView({ reading, relatedClaims: claims, sessionId, attribute: ownFilter }),
    ranked,
  );

  // A staged reset computes against an empty served set: the durable rows are still there, and
  // this call has to answer as though the session had been served nothing.
  const served =
    dedup && !resetDelivery ? readServedItems(deps.db, sessionId) : new Map<string, string>();
  const assessment = await runAssessment(deps, {
    query: cueInput,
    found: [...fusion.value.items, ...reach.items],
    unreached: reach.beyond,
    associated: resonance.value.items,
    reminders: intentions.items,
    serving: { served, dedup },
    view,
  });

  const timings: StageTimingsMs = {
    cues: cues.ms,
    embed: embedded.ms,
    seeds: selection.ms,
    activation: activation.ms,
    fusion: fusion.ms,
    resonance: resonance.ms,
    ...(assessment === undefined ? {} : { assessment: assessment.ms }),
  };

  // The serving subtractions and the assembly that reads them, applied once the candidate set is
  // final so that nothing above them measures a smaller set: ranking, the admission report and
  // the method counters all still see everything fusion admitted. What they cut is cut from
  // exposure too, since exposure is read off the assembled pack below.
  const truncated = truncationFor(activation.value.termination);
  const assembly: ServingAssembly = {
    ranked,
    served,
    dedup,
    restated,
    assembly: {
      items: fusion.value.items,
      admission: fusion.value.admission,
      caps: capsFor(deps.config),
      tokenBudget: payload.budget?.max_tokens ?? deps.config.recall.tokenBudget,
      cues: cues.value.cues,
      timings,
      ...(degradations.length === 0 ? {} : { degraded: degradations }),
      ...(obligations.pending === undefined ? {} : { pendingEnrichment: obligations.pending }),
      ...(obligations.gap === undefined ? {} : { obligationCensusGap: obligations.gap }),
      ...(truncated === undefined ? {} : { truncated }),
      restating: queryRestatements(fusion.value.items, {
        floor: deps.config.recall.restatementFloor,
        queryCues: queryCueTexts(cues.value.cues),
      }),
      entityGlossCap: deps.config.recall.entityGlossCap,
      resonant: resonance.value.items,
      intentions: intentions.items,
      historical: isTimeTravel(mode),
    },
  };
  // Recorded where assembly decides, and only when somebody is watching: a fold, a bucket cap
  // and the token budget are three different answers, and only this call site knows which.
  const assemblyDecisions: PackDecision[] = [];
  const answerFrom = (seen: ResolvedEvidenceView, from: ServingAssembly): ServedAnswer => {
    assemblyDecisions.length = 0;
    return serveFrom(
      from,
      seen,
      deps.onTrace === undefined
        ? undefined
        : (decision: PackDecision) => assemblyDecisions.push(decision),
    );
  };
  const assessed = assessedFor(assessment?.run, {
    ranking: assembly,
    candidates,
    route: deps.provider.route,
  });
  let evidence = view;
  let serving = answerFrom(evidence, assessed?.assembly ?? assembly);

  // What the answer covers, attached to the pack the caller receives rather than to the one
  // assembly measured: coverage moves no bucket and costs no token budget.
  const { checked } = options;
  const covered = servedReading(view, reach.items, assessed?.chosen ?? []);
  const stated =
    checked === undefined ? serving.pack : withCoverage(serving.pack, checked.coverage, covered);

  // Every successful-read write in one place, reset first, shaped for the boundary that checks
  // the coverage contract in the same transaction it commits them.
  const effects = servingEffects({
    sessionId,
    now,
    mode,
    pack: stated,
    temporal: {
      ...(payload.as_of === undefined ? {} : { asOf: payload.as_of }),
      ...(payload.knew_at === undefined ? {} : { knewAt: payload.knew_at }),
    },
    admission: { policy: admissionPolicy, items: fusion.value.items },
    candidates: assessed?.candidates ?? candidates,
    view,
    suppressed: serving.suppressed,
    dedup,
    cueDegraded: cues.value.degradation !== undefined || assessed?.degradation !== undefined,
    methodStats: fusion.value.methodStats,
    resonantCount: resonance.value.items.length,
    empty:
      fusion.value.items.length === 0 &&
      reach.items.length === 0 &&
      resonance.value.items.length === 0 &&
      intentions.items.length === 0,
    resetDelivery,
  });
  const disposition = await commitServingEffects(deps.db, effects, options.commit);
  // A position the substrate would not honour leaves every subtraction resting on a reading
  // nobody stood behind, so the answer is rebuilt from the same candidates under a reading that
  // admits it: what was withheld on that evidence comes back, and the statement says why. No
  // stage above is re-run, so nothing is re-ranked and no provider is called twice. A selection
  // the model made on that reading is dropped with it, and the ranking serves in its place.
  let answer = stated;
  if (disposition.kind === 'declined' && checked !== undefined) {
    evidence = revalidateFamilyPolicy(
      deps.db,
      uncertifiedThroughout(view, ids),
      checked.context,
      ranked,
    );
    serving = answerFrom(evidence, withoutAssessment(assembly, assessed));
    answer = withCoverage(
      serving.pack,
      checked.coverage,
      servedReading(evidence, reach.items, []),
      boundaryIssues(disposition.reason, resetDelivery),
    );
  }
  const emitted = emittedPackIds(serving.pack);

  logServed(deps.logger, disposition.kind === 'withheld', {
    sessionId,
    cues: cues.value.cues,
    degradations,
    seeds,
    activation: activation.value,
    fusion: fusion.value,
    resonance: resonance.value,
    intentions,
    serving,
    emitted,
    timings,
    assessment: assessed?.report,
  });

  // Every candidate assembly was offered, the assessment's pool included where it ran.
  const retrieved = [...new Set([...candidates.keys(), ...(assessed?.shown ?? [])])];
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
    withheldOwn: serving.suppressedOwn,
    withheldRepeat: serving.suppressed,
    foldEligible: serving.foldable,
    foldedCount: serving.pack.metadata.suppressed_duplicates ?? 0,
    assemblyDecisions,
    emitted,
  });

  // A refused completion means the caller received nothing, so nothing is stamped or reinforced.
  if (disposition.kind !== 'withheld') {
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
      bridgeLegs: activation.value.bridgeLegs,
      hubPenalty: activation.value.hubPenalty,
    });
  }

  return answer;
}
