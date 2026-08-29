import type { Cue, Degradation } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';
import type { Config } from '../../infrastructure/config/schema.js';
import { listSessionEpisodeIds } from '../../infrastructure/graph/episodes.js';
import type { ReadMode } from '../../infrastructure/graph/read-modes.js';
import {
  contentVectors,
  nodeCandidates,
  type SeedCandidate,
} from '../../infrastructure/graph/seed-queries.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { isLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { orchestratorLedgerKey } from '../../reflection/application/orchestrator.js';
import type { Measurement } from '../domain/admission.js';
import { scoreArrivals } from '../domain/arrival-scoring.js';
import type { RankedList } from '../domain/fusion.js';
import type { SeedCue } from './seeds.js';

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
 */
export async function embedCues(
  deps: StageReadDeps,
  cues: readonly Cue[],
): Promise<EmbeddedCues> {
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
  const rows = await contentVectors(deps.driver, { ids: [...ids], mode });
  return new Map(rows.map((row) => [row.id, row.vector]));
}

/** Hydrates the activated ids no seed strategy already carried content for. */
export async function hydrate(
  deps: StageReadDeps,
  ids: readonly string[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, SeedCandidate>> {
  const rows = await nodeCandidates(deps.driver, { ids, mode });
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The cosine every arrival is measured by, from one batched read of the content vectors the
 * arrivals already carry. It runs beside hydration rather than after it: the two ask the same
 * driver about the same ids and neither needs the other's answer, so the measurement costs the
 * fusion stage a round trip it overlaps rather than one it waits for.
 */
export async function measureArrivals(
  deps: StageReadDeps,
  ids: readonly string[],
  cues: readonly SeedCue[],
  mode: ReadMode,
): Promise<ReadonlyMap<string, Measurement[]>> {
  const rows = await contentVectors(deps.driver, { ids, mode });
  return scoreArrivals({
    arrivals: ids,
    vectors: new Map(rows.map((row) => [row.id, row.vector])),
    cues,
  });
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
