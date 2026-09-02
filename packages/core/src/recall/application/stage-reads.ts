import type { Cue, Degradation, RelatedClaim } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import type { SeedCue } from './seeds.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { normalizeCognitiveText } from '../../infrastructure/graph/cognitive-queries.js';
import { listSessionEpisodeIds } from '../../infrastructure/graph/episodes.js';
import { fetchItemOrigins, type ItemOrigin } from '../../infrastructure/graph/origin-queries.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import { findRelatedClaims } from '../../infrastructure/graph/related-claim-queries.js';
import {
  contentVectors,
  nodeCandidates,
  type SeedCandidate,
} from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import { embedQueryPrefix } from '../../infrastructure/providers/embed-models.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { orchestratorLedgerKey } from '../../reflection/application/orchestrator.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';
import type { Measurement } from '../domain/admission.js';
import { scoreArrivals } from '../domain/arrival-scoring.js';
import type { FusedItem, RankedList } from '../domain/fusion.js';

/**
 * The one embedding call recall makes and the reads it makes against ids it already holds,
 * split out of `recall.ts` so that file is the stage order and nothing else. Each of these is
 * a step's supporting work rather than a step: none of them decides what surfaces.
 */

export type StageReadDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly provider: Provider;
  readonly config: Config;
  readonly logger: Logger;
};

export type EmbeddedCues = {
  readonly cues: readonly SeedCue[];
  readonly degradation?: Degradation;
};

/**
 * One batched `embed` for every cue, including the degradation ladder's raw-query cue. An
 * embedding outage costs recall its vector leg and nothing else: BM25, exact entity
 * resolution, recency, and traversal all run on cue text or on graph structure, which is the
 * ladder's deeper rung. The rung is reported, because a pack answered without its semantic
 * leg is a thinner answer than the caller has any other way to see.
 *
 * Recall embeds a query here, and the model's query prefix goes on it. Stored vectors and every
 * symmetric comparison stay raw. The prefix marks the text sent to the model and never the cue:
 * what is stored, logged, and matched on downstream is the cue the caller asked with.
 *
 * This is not the only query-shaped embed in the product. `aion search`, `aion forget`, the
 * doctor's floor check and the committed calibrations all take the same prefix from the same
 * table, because a query spelled two ways scores against one set of stored vectors under one
 * set of floors.
 */
export async function embedCues(deps: StageReadDeps, cues: readonly Cue[]): Promise<EmbeddedCues> {
  if (cues.length === 0) {
    return { cues: [] };
  }
  const queryPrefix = embedQueryPrefix(deps.config.models.embed);
  let vectors: readonly Vector[] = [];
  try {
    vectors = await deps.provider.embed(cues.map((cue) => `${queryPrefix}${cue.text}`));
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

/** Content vectors for the whole ranked set, fetched only when the reranker is MMR. */
export async function mmrVectors(
  deps: StageReadDeps,
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
  try {
    const rows = await contentVectors(deps.driver, { ids: [...ids], mode });
    return new Map(rows.map((row) => [row.id, row.vector]));
  } catch (err) {
    // No vectors is the RRF ordering, which is a coarser pack rather than no pack.
    deps.logger.warn({ err }, 'mmr vector read failed; the pack is ordered by fused rank');
    return undefined;
  }
}

/**
 * Hydrates the activated ids no seed strategy already carried content for.
 *
 * Best-effort, like the reads below it: an empty map costs the pack the arrivals, since fusion
 * drops a candidate with no content, and leaves it the seeds that already carry theirs.
 */
export async function hydrate(
  deps: StageReadDeps,
  ids: readonly string[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, SeedCandidate>> {
  try {
    const rows = await nodeCandidates(deps.driver, { ids, mode });
    return new Map(rows.map((row) => [row.id, row]));
  } catch (err) {
    deps.logger.warn({ err }, 'arrival hydration failed; the pack keeps the seeds it has');
    return new Map();
  }
}

/**
 * The cosine every arrival is measured by, from one batched read of the content vectors the
 * arrivals already carry. It runs beside hydration rather than after it: the two ask the same
 * driver about the same ids and neither needs the other's answer, so the measurement costs the
 * fusion stage a round trip it overlaps rather than one it waits for.
 *
 * Best-effort: unmeasured arrivals are refused by the gate, so a failure here costs the pack
 * what activation reached and never the seeds' own answer.
 */
export async function measureArrivals(
  deps: StageReadDeps,
  ids: readonly string[],
  cues: readonly SeedCue[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, Measurement[]>> {
  let rows: Awaited<ReturnType<typeof contentVectors>> = [];
  try {
    rows = await contentVectors(deps.driver, { ids, mode });
  } catch (err) {
    deps.logger.warn({ err }, 'arrival measurement failed; the arrivals go unmeasured');
  }
  return scoreArrivals({
    arrivals: ids,
    vectors: new Map(rows.map((row) => [row.id, row.vector])),
    cues,
  });
}

/** The label that says a resonant hit is captured text rather than a distilled claim. */
const TURN_LABEL = 'Turn';

/**
 * The current claim beside each raw turn resonance surfaced, keyed by the turn's id.
 *
 * Only resonant turns are asked about. A turn the query matched directly arrives beside
 * whatever else the query matched, so the pack already carries its context; a turn resonance
 * found alone carries a stated belief and nothing else, and nothing ever supersedes a turn.
 * One query for the batch, and none at all when the bucket holds no turns.
 *
 * Best-effort, like the pending-enrichment count: a failure here costs the pack an annotation
 * and never the recall itself.
 */
export async function relatedClaims(
  deps: StageReadDeps,
  resonant: readonly FusedItem[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, RelatedClaim>> {
  const turns = resonant
    .filter((item) => item.labels.includes(TURN_LABEL))
    .map((item) => ({ id: item.id, textNorm: normalizeCognitiveText(item.content) }));
  if (turns.length === 0) {
    return new Map();
  }
  try {
    const rows = await findRelatedClaims(deps.driver, {
      turns,
      floor: deps.config.recall.relatedClaimFloor,
      mode,
    });
    return new Map(rows.map((row) => [row.turnId, { id: row.id, text: row.text }]));
  } catch (err) {
    deps.logger.warn({ err }, 'related-claim lookup failed; the resonant turns go unannotated');
    return new Map();
  }
}

/**
 * Which sessions produced each candidate, in one batched read beside the related-claim
 * lookup rather than a question per item. It runs late because the candidate set is only final
 * after the second pass, and it asks about ids the run already holds, so it costs the call a
 * round trip it overlaps with the read next to it.
 *
 * Best-effort, and the empty answer is the safe one: an outage here leaves every item served,
 * which is the behavior of the knob turned off rather than a pack missing memories nobody can
 * explain.
 */
export async function itemOrigins(
  deps: StageReadDeps,
  ids: readonly string[],
  sessionId: string,
  mode: ReadMode,
): Promise<ReadonlyMap<string, ItemOrigin>> {
  if (ids.length === 0) {
    return new Map();
  }
  try {
    return await fetchItemOrigins(deps.driver, { ids, sessionId, mode });
  } catch (err) {
    deps.logger.warn({ err, sessionId }, 'origin lookup failed; the pack repeats what it holds');
    return new Map();
  }
}

/**
 * The calling session's own episodes with no orchestrator ledger key: stored and
 * findable by raw text, but not yet reachable by entity resolution, traversal, or context
 * vectors. Best-effort: a failure here costs the pack one honesty field, never the recall
 * itself, so it is caught and logged rather than allowed to fail the call.
 */
export async function pendingEnrichment(
  deps: StageReadDeps,
  sessionId: string,
  mode: ReadMode,
): Promise<number> {
  try {
    const episodeIds = await listSessionEpisodeIds(deps.driver, sessionId, mode);
    let count = 0;
    for (const episodeId of episodeIds) {
      if (!isLedgerApplied(deps.db, orchestratorLedgerKey(PIPELINE_VERSION, episodeId))) {
        count += 1;
      }
    }
    return count;
  } catch (err) {
    deps.logger.warn({ err, sessionId }, 'pending-enrichment count failed; omitted from the pack');
    return 0;
  }
}
