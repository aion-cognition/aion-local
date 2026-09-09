import { packBuckets, type MemoryPack } from '@aion/protocol';

import { idAddress } from '../../../evidence/domain/address.js';
import { openSqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  relatedIncidenceNodes,
  sampleSourcesAcceptedBefore,
  servedReferenceOutcome,
  type AcceptedSourceSample,
} from '../../../infrastructure/sqlite/probe-incidence.js';
import {
  recordProbeIneligible,
  recordProbeTrialV2,
  recordProbeUnavailable,
  recordServedReferenceReadingV2,
  type ServedReferenceInputV2,
} from '../../../infrastructure/sqlite/recall-probe-counters.js';
import { listServedItemsBefore } from '../../../infrastructure/sqlite/served-items.js';
import { checkCoverage } from '../../../recall/application/coverage-checker.js';
import { CueCache } from '../../../recall/application/cues.js';
import { handleRecall, type RecallDeps } from '../../../recall/application/recall.js';
import { processingReadinessOf } from '../../../reflection/application/readiness.js';
import { bucketStamp } from '../../domain/buckets.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
  RecallProbe,
} from '../../domain/operation.js';
import {
  PROBE_ACCEPTANCE_AGE_MS,
  sampleEligibility,
  type SampleIneligibleReason,
} from '../../domain/probe-sample.js';
import { sourceReadDeps } from '../source-wire.js';

/**
 * The one sense that measures the whole loop from the inside. It takes sources the substrate
 * accepted more than a day ago and has finished processing, asks for each of them back in the
 * words they arrived in, and records two separate things: whether the raw record can still be
 * inspected, and whether the pack held anything the records say came from it. Beside them, from
 * the same run, the other half of the same question: of what recall handed out, how much the
 * conversation afterward actually came back to.
 *
 * What it does not measure is whether the answer was good. A chunk covering a hundred sources
 * and citing one has a recorded relationship to all hundred and answered for none of them, so
 * `answer_quality` is left to source-specific fixtures and declared evaluations rather than
 * inferred from a structural hit.
 *
 * A probe must teach the substrate nothing, or the next run scores what the last one taught it.
 * Isolation is by construction rather than by a flag, and `probeRecall` below is the whole
 * mechanism: the probe's recall deps are written out field by field, so every writer recall
 * holds is accounted for.
 *
 * - Reinforcement, access stamps and the usage stream all hang off `onRecalled`, which the probe
 *   deps leave out. No listener, no graph write, no queue row.
 * - `saveLastPack`, the typed-admission ledger, the served-item rows, the cue-degradation window,
 *   the pack-method counters and the recall cadence totals all write through `RecallDeps.db`.
 *   The probe hands recall a throwaway in-memory store, so those writes land there and are
 *   dropped when the run ends. The substrate's own store sees only what this operation writes:
 *   the probe counters and one ledger row.
 * - The source reads go through the evidence resolver against the real records, read-only, with
 *   no publication position taken and nothing stamped.
 * - Session dedup and the own-session filter are off in the probe's config, so no serve is
 *   recorded and the pack is scored on everything retrieval found rather than on what a
 *   conversation had already seen.
 * - The identity is a fixed, obviously-named string. `sessionIdFor` resolves it without minting
 *   anything, and recall creates no Session node, so the probe never enters the graph's session
 *   machinery.
 *
 * One residue, deliberate and wanted: the cue call the recall pipeline makes counts in the
 * generation counters like any other. Those measure whether the model routes answer, and a probe
 * call is a real call.
 */

export const RECALL_PROBE_OPERATION = 'recall_probe';

export const RECALL_PROBE_LEDGER_PREFIX = 'recall_probe:';

/** One row per day the probe ran, holding which sources it asked about and what came back. */
export function recallProbeLedgerKey(stamp: string): string {
  return `${RECALL_PROBE_LEDGER_PREFIX}${stamp}`;
}

/**
 * The session identity every probe recall runs under. Fixed rather than per run: nothing keys on
 * it in the substrate's own store, and one obviously-named identity is easier to recognise in a
 * log than a fresh one each time.
 */
export const RECALL_PROBE_IDENTITY = 'aion-recall-probe';

/**
 * Standing relevance, like `curiosity` and `intention_upkeep`: no health snapshot counts what a
 * probe would find, so the operation reaches the urgency threshold on waiting time. Low, because
 * a day-old retrieval rate is not urgent on any single tick.
 */
export const RECALL_PROBE_STANDING_RELEVANCE = 0.1;

/**
 * How much of a source becomes the query. Long enough to carry what it was about, short enough
 * that the cue model reads a question rather than a transcript.
 */
const QUERY_MAX_CHARS = 400;

/**
 * A bound on the served rows one run judges. The table is small by construction (a session's
 * rows go when it closes, and the idle purge takes the rest), so this is a ceiling against a
 * pathological case rather than a sample size worth tuning.
 */
const SERVED_ITEM_CAP = 500;

/**
 * The source in its own words, which is the query. The raw text is asked back verbatim rather
 * than drafted into a question: a model rewriting the query would measure the rewrite as much as
 * the retrieval, and there is nothing to learn from a question the substrate composed about text
 * it is holding.
 *
 * A capture of tool exhaust alone has no such words and is skipped rather than queried on a tool
 * name. Observations come first, since a distilled line is what a member would ask back.
 */
export type ProbeQueryPart = {
  readonly partKind: string;
  readonly role?: string;
  readonly text: string;
};

/**
 * The reconstruction prefixes a part with the position it was captured under, which is context
 * for a reader and noise in a query. Stripping it here keeps the question the words the member
 * actually wrote.
 */
function spokenText(part: ProbeQueryPart): string {
  const prefix = part.partKind === 'observation' ? 'observation' : part.role;
  const marker = prefix === undefined ? undefined : `${prefix}: `;
  const text =
    marker !== undefined && part.text.startsWith(marker)
      ? part.text.slice(marker.length)
      : part.text;
  return text.trim();
}

export function probeQueryFromParts(parts: readonly ProbeQueryPart[]): string | undefined {
  const spoken = (kind: string): string | undefined => {
    for (const part of parts) {
      const text = part.partKind === kind ? spokenText(part) : '';
      if (text.length > 0) {
        return text;
      }
    }
    return undefined;
  };
  const text = spoken('observation') ?? spoken('turn');
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  return text.length > QUERY_MAX_CHARS ? text.slice(0, QUERY_MAX_CHARS) : text;
}

/**
 * The isolated recall, built where the real deps live. Every field is named rather than spread,
 * so a field added to `RecallDeps` fails to compile here and gets a decision instead of being
 * carried into the probe by accident. `onRecalled` is the one field deliberately absent.
 */
export function probeRecall(deps: RecallDeps): RecallProbe {
  // The probe's own cue cache, so probe queries never fill or answer from the cache the live
  // recalls share.
  const cueCache = new CueCache({ ttlMinutes: deps.config.recall.cueCacheTtlMinutes });
  return async (request) => {
    const scratch = openSqliteHandle({ filePath: ':memory:' });
    try {
      return await handleRecall(
        {
          driver: deps.driver,
          db: scratch,
          sessions: deps.sessions,
          provider: deps.provider,
          config: {
            ...deps.config,
            recall: { ...deps.config.recall, sessionDedup: false, ownSessionFilter: false },
          },
          cueCache,
          logger: deps.logger,
        },
        { query: request.query },
        { identity: request.identity, now: request.now },
      );
    } finally {
      scratch.close();
    }
  };
}

function noop(detail: string): OperationOutcome {
  return { status: 'noop', itemsProcessed: 0, itemsAffected: 0, detail };
}

type ProbeTrial = {
  readonly sourceId: string;
  /** The sampled raw record can be inspected with verified identity and evidence. */
  readonly resolvable: boolean;
  /** An emitted item has a recorded source relationship to the sample. */
  readonly relatedRetrieval: boolean;
};

/** Why one sample produced no trial, kept as its own answer rather than folded into a miss. */
type SkipReason = SampleIneligibleReason | 'no_words' | 'source_withheld';

type SampleOutcome =
  | { readonly kind: 'trial'; readonly trial: ProbeTrial }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'ineligible'; readonly reason: SkipReason };

type Tally = {
  readonly trials: readonly ProbeTrial[];
  readonly unavailable: number;
  readonly ineligible: Readonly<Partial<Record<SkipReason, number>>>;
};

/**
 * The served-then-referenced reading, over the same cutoff the samples use. Three outcomes and
 * not two: an item nothing points at is a measured absence, and an item whose incidence carries
 * no acknowledged clock is a question the records cannot answer. Reporting the second as the
 * first would credit a backfill's discovery to the conversation.
 */
function measureServedReferences(ctx: OperationContext, before: string): ServedReferenceInputV2 {
  const served = listServedItemsBefore(ctx.db, before, SERVED_ITEM_CAP);
  let referenced = 0;
  let unversioned = 0;
  for (const row of served) {
    const outcome = servedReferenceOutcome(ctx.db, row.itemId, row.firstServedAt);
    if (outcome === 'referenced_after') {
      referenced += 1;
    } else if (outcome === 'unversioned') {
      unversioned += 1;
    }
  }
  return {
    items: served.length,
    referenced,
    unversioned,
    measuredAt: ctx.now.toISOString(),
  };
}

function detailFor(sampled: number, tally: Tally, served: ServedReferenceInputV2): string {
  const resolvable = tally.trials.filter((trial) => trial.resolvable).length;
  const related = tally.trials.filter((trial) => trial.relatedRetrieval).length;
  const skipped = Object.values(tally.ineligible).reduce((sum, value) => sum + value, 0);
  return (
    `asked back ${String(tally.trials.length)} of ${String(sampled)} sampled source(s); ` +
    `${String(resolvable)} resolvable, ${String(related)} with a recorded source relationship; ` +
    `${String(skipped)} ineligible, ${String(tally.unavailable)} unavailable; ` +
    `${String(served.referenced)} of ${String(served.items)} served item(s) referenced since, ` +
    `${String(served.unversioned)} undatable`
  );
}

/** One question, its verdict, and nothing inferred from either. */
async function probeOnce(
  ctx: OperationContext,
  probe: RecallProbe,
  sourceId: string,
  query: string,
): Promise<{ readonly relatedRetrieval: boolean } | undefined> {
  let pack: MemoryPack;
  try {
    pack = await probe({ query, identity: RECALL_PROBE_IDENTITY, now: ctx.now });
  } catch (err) {
    ctx.logger.warn({ err, sourceId }, 'recall probe could not ask; leaving the sample unscored');
    return undefined;
  }
  const buckets = packBuckets(pack);
  const candidateIds = Object.values(buckets).flatMap((items) => items.map((item) => item.id));
  return { relatedRetrieval: relatedIncidenceNodes(ctx.db, sourceId, candidateIds).length > 0 };
}

async function scoreSample(
  ctx: OperationContext,
  probe: RecallProbe,
  sample: AcceptedSourceSample,
): Promise<SampleOutcome> {
  // Readiness is read against the stage set this source's own accepted policy required, which is
  // the only reading that can tell an inventory nobody wrote from one that owes nothing.
  const eligibility = sampleEligibility(
    sample,
    processingReadinessOf(ctx.db, sample.sourceId),
    ctx.now,
  );
  if (eligibility.status === 'ineligible') {
    recordProbeIneligible(ctx.db);
    if (eligibility.detail !== undefined && eligibility.detail.length > 0) {
      ctx.logger.debug(
        { sourceId: sample.sourceId, reason: eligibility.reason, records: eligibility.detail },
        'recall probe skipped a sample its records cannot account for',
      );
    }
    return { kind: 'ineligible', reason: eligibility.reason };
  }
  const checked = checkCoverage(ctx.db, { now: ctx.now, expiryAnnotation: true });
  if (checked.status === 'refused') {
    recordProbeUnavailable(ctx.db);
    return { kind: 'unavailable' };
  }
  const reads = sourceReadDeps({ driver: ctx.driver, db: ctx.db, logger: ctx.logger });
  const batch = await reads.resolver.resolveSources(
    [idAddress(sample.sourceId)],
    checked.context,
    'raw_inspection',
  );
  const result = [...batch.results.values()][0];
  const resolvable = result?.evidence.status === 'complete-for-use' && result.value !== undefined;
  // Whether the source could be read at all is settled before anything is asked of its text.
  // A source whose archive cannot be reached has not told the probe that it holds no words,
  // and recording it as a wordless sample would report an outage as a property of the corpus.
  if (result?.value === undefined) {
    if (result?.evidence.status === 'not-found-in-coverage') {
      // The substrate answered: the source is withheld or certified absent at this vantage.
      // That is a sample the policy excludes, not a store this run could not reach.
      recordProbeIneligible(ctx.db);
      return { kind: 'ineligible', reason: 'source_withheld' };
    }
    ctx.logger.warn(
      { sourceId: sample.sourceId },
      'recall probe could not read the sampled source; leaving it unscored',
    );
    recordProbeUnavailable(ctx.db);
    return { kind: 'unavailable' };
  }
  const query = probeQueryFromParts(result.value.parts);
  if (query === undefined) {
    recordProbeIneligible(ctx.db);
    return { kind: 'ineligible', reason: 'no_words' };
  }
  const asked = await probeOnce(ctx, probe, sample.sourceId, query);
  if (asked === undefined) {
    recordProbeUnavailable(ctx.db);
    return { kind: 'unavailable' };
  }
  const trial: ProbeTrial = {
    sourceId: sample.sourceId,
    resolvable,
    relatedRetrieval: asked.relatedRetrieval,
  };
  recordProbeTrialV2(ctx.db, trial);
  return { kind: 'trial', trial };
}

async function runRecallProbe(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.recallProbe) {
    return noop('recall probe disabled by AION_MAINTENANCE_RECALL_PROBE; nothing asked');
  }
  const { recallProbe } = ctx;
  if (recallProbe === undefined) {
    return noop('recall probe has no isolated recall to ask through; nothing asked');
  }

  // Acceptance, not world time: a source is mature when the substrate has held it long enough
  // for its pipeline to have finished with it, which is a fact about this substrate.
  const before = new Date(ctx.now.getTime() - PROBE_ACCEPTANCE_AGE_MS).toISOString();
  const sampled = sampleSourcesAcceptedBefore(
    ctx.db,
    before,
    ctx.config.maintenance.recallProbeSample,
  );

  const trials: ProbeTrial[] = [];
  const ineligible: Partial<Record<SkipReason, number>> = {};
  let unavailable = 0;
  for (const sample of sampled) {
    if (ctx.signal.aborted) {
      break;
    }
    const outcome = await scoreSample(ctx, recallProbe, sample);
    if (outcome.kind === 'trial') {
      trials.push(outcome.trial);
    } else if (outcome.kind === 'unavailable') {
      unavailable += 1;
    } else {
      ineligible[outcome.reason] = (ineligible[outcome.reason] ?? 0) + 1;
    }
  }
  const tally: Tally = { trials, unavailable, ineligible };

  const served = measureServedReferences(ctx, before);
  recordServedReferenceReadingV2(ctx.db, served);
  markLedgerApplied(ctx.db, recallProbeLedgerKey(bucketStamp('day', ctx.now)), {
    probedAt: ctx.now.toISOString(),
    // Ids only. What a probe asked is stored text, and the ledger is not where it goes.
    sources: tally.trials.map((trial) => ({
      id: trial.sourceId,
      resolvable: trial.resolvable,
      relatedRetrieval: trial.relatedRetrieval,
    })),
    ineligible: tally.ineligible,
    unavailable: tally.unavailable,
    served,
  });

  return {
    status: tally.trials.length === 0 ? 'noop' : 'applied',
    itemsProcessed: sampled.length,
    // Measurements taken rather than anything changed: this operation's whole output is the
    // tallies, and a run that scored nothing has done nothing.
    itemsAffected: tally.trials.length,
    detail: detailFor(sampled.length, tally, served),
  };
}

export function recallProbeOperation(): IntrospectionOperation {
  return {
    name: RECALL_PROBE_OPERATION,
    bucket: 'day',
    enabled: (config) => config.maintenance.recallProbe,
    relevance: () => RECALL_PROBE_STANDING_RELEVANCE,
    run: runRecallProbe,
  };
}
