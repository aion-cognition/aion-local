import { packBuckets, type MemoryPack } from '@aion/protocol';

import {
  countServedReferences,
  findPackCoverage,
} from '../../../infrastructure/graph/recall-probe-queries.js';
import { openSqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { sampleExperiencesBefore } from '../../../infrastructure/sqlite/experience-archive.js';
import { markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  recordRecallProbeTrial,
  recordServedReferenceReading,
  type ServedReferenceInput,
} from '../../../infrastructure/sqlite/recall-probe-counters.js';
import { listServedItemsBefore } from '../../../infrastructure/sqlite/served-items.js';
import { CueCache } from '../../../recall/application/cues.js';
import { handleRecall, type RecallDeps } from '../../../recall/application/recall.js';
import type { ReflectionContent } from '../../../reflection/domain/content.js';
import { bucketStamp } from '../../domain/buckets.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
  RecallProbe,
} from '../../domain/operation.js';

/**
 * The one sense that measures the whole loop from the inside. It takes experiences the substrate
 * was told about more than a day ago, asks for each of them back in the words they arrived in,
 * and scores whether the pack answered. Beside it, from the same run, the other half of the same
 * question: of what recall handed out, how much the conversation afterward actually used.
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

/** One row per day the probe ran, holding which experiences it asked about and what came back. */
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much of an experience becomes the query. Long enough to carry what the experience was
 * about, short enough that the cue model reads a question rather than a transcript.
 */
const QUERY_MAX_CHARS = 400;

/**
 * A bound on the served rows one run judges. The table is small by construction (a session's
 * rows go when it closes, and the idle purge takes the rest), so this is a ceiling against a
 * pathological case rather than a sample size worth tuning.
 */
const SERVED_ITEM_CAP = 500;

/**
 * The experience in its own words, which is the query. The archive text is asked back verbatim
 * rather than drafted into a question: a model rewriting the query would measure the rewrite as
 * much as the retrieval, and there is nothing to learn from a question the substrate composed
 * about text it is holding.
 *
 * An episode of tool exhaust alone has no such words and is skipped rather than queried on a
 * tool name.
 */
export function probeQuery(payload: ReflectionContent): string | undefined {
  const observation = payload.observations?.find((text) => text.trim().length > 0);
  const turn = payload.turns?.find((entry) => entry.text.trim().length > 0);
  const text = (observation ?? turn?.text)?.trim();
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
  const cueCache = new CueCache();
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
  readonly episodeId: string;
  readonly hit: boolean;
};

/**
 * One question and its verdict. A hit is any of the three ways a pack answers for an experience:
 * the episode itself, something extraction pulled out of it, or the narrative that compressed it.
 *
 * A recall that threw is not a miss and is not counted. The probe measures retrieval, and an
 * embedder that is down would otherwise read as the substrate forgetting.
 */
async function probeOnce(
  ctx: OperationContext,
  probe: RecallProbe,
  episodeId: string,
  query: string,
): Promise<ProbeTrial | undefined> {
  let pack: MemoryPack;
  try {
    pack = await probe({ query, identity: RECALL_PROBE_IDENTITY, now: ctx.now });
  } catch (err) {
    ctx.logger.warn({ err, episodeId }, 'recall probe could not ask; leaving the sample unscored');
    return undefined;
  }
  const buckets = packBuckets(pack);
  const candidateIds = Object.values(buckets).flatMap((items) => items.map((item) => item.id));
  const covering = await findPackCoverage(ctx.driver, { episodeId, candidateIds });
  return { episodeId, hit: covering.length > 0 };
}

/**
 * The served-then-referenced reading, over the same cutoff the samples use. It is a rate over
 * rows that are still on file, so it says how much of what a running conversation was handed
 * came back into the conversation, and it reads as nothing at all on a substrate whose sessions
 * have all closed.
 */
async function measureServedReferences(
  ctx: OperationContext,
  before: string,
): Promise<ServedReferenceInput> {
  const served = listServedItemsBefore(ctx.db, before, SERVED_ITEM_CAP);
  const referenced = await countServedReferences(
    ctx.driver,
    served.map((row) => ({ itemId: row.itemId, firstServedAt: new Date(row.firstServedAt) })),
  );
  return { items: served.length, referenced, measuredAt: ctx.now.toISOString() };
}

function detailFor(
  sampled: number,
  trials: readonly ProbeTrial[],
  served: ServedReferenceInput,
): string {
  const hits = trials.filter((trial) => trial.hit).length;
  return (
    `asked back ${String(trials.length)} of ${String(sampled)} sampled experience(s), ` +
    `${String(hits)} recalled; ${String(served.referenced)} of ${String(served.items)} ` +
    'served item(s) referenced since'
  );
}

async function runRecallProbe(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.recallProbe) {
    return noop('recall probe disabled by AION_MAINTENANCE_RECALL_PROBE; nothing asked');
  }
  const { recallProbe } = ctx;
  if (recallProbe === undefined) {
    return noop('recall probe has no isolated recall to ask through; nothing asked');
  }

  // A day, so the sample is past every lane's enrichment backlog: an experience that is still
  // being enriched would be scored on a pipeline that has not finished with it.
  const before = new Date(ctx.now.getTime() - DAY_MS).toISOString();
  const sampled = sampleExperiencesBefore(ctx.db, before, ctx.config.maintenance.recallProbeSample);

  const trials: ProbeTrial[] = [];
  for (const row of sampled) {
    if (ctx.signal.aborted) {
      break;
    }
    const query = probeQuery(row.payload);
    if (query === undefined) {
      continue;
    }
    const trial = await probeOnce(ctx, recallProbe, row.episodeId, query);
    if (trial === undefined) {
      continue;
    }
    trials.push(trial);
    recordRecallProbeTrial(ctx.db, { hit: trial.hit });
  }

  const served = await measureServedReferences(ctx, before);
  recordServedReferenceReading(ctx.db, served);
  markLedgerApplied(ctx.db, recallProbeLedgerKey(bucketStamp('day', ctx.now)), {
    probedAt: ctx.now.toISOString(),
    // Ids only. What a probe asked is stored text, and the ledger is not where it goes.
    episodes: trials.map((trial) => ({ id: trial.episodeId, hit: trial.hit })),
    served,
  });

  return {
    status: trials.length === 0 ? 'noop' : 'applied',
    itemsProcessed: sampled.length,
    // Measurements taken rather than anything changed: this operation's whole output is the two
    // numbers, and a run that scored nothing has done nothing.
    itemsAffected: trials.length,
    detail: detailFor(sampled.length, trials, served),
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
