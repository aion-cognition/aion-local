import type { Driver } from 'neo4j-driver';

import {
  findSimilarCurrentEntities,
  loadEntityDedupDetails,
  type DedupEntityDetail,
} from '../../../infrastructure/graph/entity-dedup-queries.js';
import {
  nominateSharedEpisodePairs,
  type NominationResult,
} from '../../../infrastructure/graph/entity-nomination-queries.js';
import {
  readEntityPairSignals,
  type EntityPairSignals,
} from '../../../infrastructure/graph/entity-signal-queries.js';
import {
  findAliasEqualityPairs,
  findSquashEqualityGroups,
} from '../../../infrastructure/graph/entity-tier0-queries.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import { groupDuplicates, selectCanonical, type DuplicatePair } from '../../domain/entity-merge.js';

/**
 * The first three tiers of the entity cascade, which between them decide nothing and merge
 * nothing. Tier 0 finds the pairs the graph is already holding twice under a spelling the
 * `name_norm` key cannot see. Tier 1 nominates: a name-vector search per subject, and one bulk
 * GDS pass over shared episodes that reaches the duplicates no vector was ever going to compare.
 * Tier 2 measures what the two share and hands it on as facts.
 *
 * Type is nowhere in here. It used to route a cross-type pair away from the merge path
 * entirely, which made a duplicate invisible for as long as two extractions disagreed about
 * what kind of thing it was; identity keys on the name now, and the type readings travel as
 * evidence for a judge to weigh.
 */

/** Enough to catch a genuine near-duplicate without turning one entity into a graph-wide scan. */
export const CANDIDATE_SEARCH_LIMIT = 8;

/** A tick's ceiling on the deterministic sweep, so one pathological graph cannot fill a run. */
export const TIER0_GROUP_LIMIT = 64;

/**
 * Every identity the cascade has looked at this run, loaded once. Two tiers ask about the same
 * node routinely (a tier-0 group member turns up again as a vector neighbour), and a second
 * read would also be a second reading: the first tier's merge changes what the second would see.
 */
export class EntityDetailCache {
  readonly #driver: Driver;
  readonly #details = new Map<string, DedupEntityDetail>();

  constructor(driver: Driver) {
    this.#driver = driver;
  }

  get(id: string): DedupEntityDetail | undefined {
    return this.#details.get(id);
  }

  /** Hydrates whatever is missing and returns the rows for every id that names a node. */
  async require(ids: readonly string[]): Promise<DedupEntityDetail[]> {
    const missing = [...new Set(ids)].filter((id) => !this.#details.has(id));
    if (missing.length > 0) {
      for (const detail of await loadEntityDedupDetails(this.#driver, missing)) {
        this.#details.set(detail.id, detail);
      }
    }
    return ids
      .map((id) => this.#details.get(id))
      .filter((detail): detail is DedupEntityDetail => detail !== undefined);
  }

  /** Marks an absorbed identity as gone, so a later tier in the same run cannot nominate it. */
  absorb(id: string): void {
    const detail = this.#details.get(id);
    if (detail !== undefined) {
      this.#details.set(id, { ...detail, current: false });
    }
  }

  isCurrent(id: string): boolean {
    return this.#details.get(id)?.current === true;
  }
}

/** One group tier 0 is prepared to merge, with the canonical already chosen. */
export type CascadeGroup = {
  readonly canonical: DedupEntityDetail;
  /** The canonical included, so alias and salience accumulation see the whole group. */
  readonly members: readonly DedupEntityDetail[];
  readonly reasons: readonly string[];
};

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

export type Tier0Options = {
  readonly subjectIds?: readonly string[];
  readonly limit?: number;
};

/**
 * The deterministic sweep. Squash equality and unambiguous alias equality are read separately
 * and then closed transitively, because one identity can be reached both ways at once.
 *
 * The direct-relation guard is what the transitive closure needs to stay honest. A chain can
 * put A and C in one group because both relate to B, and merging A into C on that basis is how
 * one Postgres node came to contain Redis and Valkey. A member merges only when it holds a
 * deterministic relation to the canonical itself.
 */
export async function findTier0Groups(
  driver: Driver,
  cache: EntityDetailCache,
  options: Tier0Options = {},
): Promise<CascadeGroup[]> {
  const limit = options.limit ?? TIER0_GROUP_LIMIT;
  const scan = {
    ...(options.subjectIds === undefined ? {} : { subjectIds: options.subjectIds }),
    limit,
  };
  const [squashGroups, aliasPairs] = await Promise.all([
    findSquashEqualityGroups(driver, scan),
    findAliasEqualityPairs(driver, scan),
  ]);

  const pairs: DuplicatePair[] = [];
  const reasons = new Map<string, string>();
  for (const group of squashGroups) {
    // Every pair inside the group, not a chain through the first id: they all hold the one key,
    // and the guard below asks about the canonical, which is not chosen until afterwards.
    for (const [index, left] of group.ids.entries()) {
      for (const right of group.ids.slice(index + 1)) {
        pairs.push({ a: left, b: right });
        reasons.set(pairKey(left, right), `both names squash to ${group.squash}`);
      }
    }
  }
  for (const pair of aliasPairs) {
    pairs.push({ a: pair.holderId, b: pair.ownerId });
    reasons.set(
      pairKey(pair.holderId, pair.ownerId),
      `one already answers to the other's name, as the alias ${pair.aliasKey}`,
    );
  }
  if (pairs.length === 0) {
    return [];
  }

  const related = new Set(pairs.map((pair) => pairKey(pair.a, pair.b)));
  const groups: CascadeGroup[] = [];
  for (const ids of groupDuplicates(pairs)) {
    const members = (await cache.require(ids)).filter((detail) => detail.current);
    if (members.length < 2) {
      continue;
    }
    const canonical = selectCanonical(members);
    const merging = members.filter(
      (member) => member.id === canonical.id || related.has(pairKey(canonical.id, member.id)),
    );
    if (merging.length < 2) {
      continue;
    }
    groups.push({
      canonical,
      members: merging,
      reasons: merging
        .filter((member) => member.id !== canonical.id)
        .map(
          (member) =>
            reasons.get(pairKey(canonical.id, member.id)) ??
            'the two names meet under a deterministic reading',
        ),
    });
  }
  return groups;
}

/** A pair some nominator put forward, with whatever measured it and whatever tier 2 read. */
export type NominatedPair = {
  readonly leftId: string;
  readonly rightId: string;
  /** Present when a name-vector search nominated it; absent when only the graph did. */
  readonly nominatingCosine?: number;
  /** Present when the bulk shared-episode pass nominated it. */
  readonly sharedEpisodeJaccard?: number;
  /** Tier 2's reading. Absent when the pair lost a side between nomination and measurement. */
  readonly signals?: EntityPairSignals;
};

/**
 * A nominator that cannot run is not a failed stage. The bulk pass holds one projection under
 * one static name, so two reflections running at once (`AION_WORKER_COUNT` above one) can drop
 * each other's build mid-stream. The vector nominator carries the run either way, and the next
 * episode rebuilds the projection from scratch.
 */
async function bulkNominations(driver: Driver, input: NominationInput): Promise<NominationResult> {
  try {
    return await nominateSharedEpisodePairs(driver, {
      jaccardFloor: input.sharedEpisodeJaccardFloor,
      logger: input.logger,
    });
  } catch (err) {
    input.logger.warn({ err }, 'entity shared-episode nomination skipped');
    return { status: 'unavailable' };
  }
}

export type NominationInput = {
  readonly subjectIds: readonly string[];
  readonly similarityThreshold: number;
  readonly sharedEpisodeJaccardFloor: number;
  readonly logger: Logger;
};

/**
 * Tier 1. Both nominators run; neither decides. The vector search is per subject and finds
 * names that look alike; the bulk pass is one GDS call over the whole graph and finds names
 * seen in the same episodes, which is the duplicate shape a name vector cannot see at all. A
 * pair either turns up is a pair the evidence tiers get to read, whatever the two are typed as.
 */
export async function nominatePairs(
  driver: Driver,
  cache: EntityDetailCache,
  input: NominationInput,
): Promise<NominatedPair[]> {
  const nominated = new Map<string, NominatedPair>();

  for (const id of input.subjectIds) {
    const subject = cache.get(id);
    if (subject === undefined || !subject.current || subject.nameVector === undefined) {
      continue;
    }
    const matches = await findSimilarCurrentEntities(driver, {
      excludeId: subject.id,
      vector: subject.nameVector,
      threshold: input.similarityThreshold,
      limit: CANDIDATE_SEARCH_LIMIT,
    });
    for (const match of matches) {
      nominated.set(pairKey(subject.id, match.id), {
        leftId: subject.id,
        rightId: match.id,
        nominatingCosine: match.score,
      });
    }
  }

  const subjects = new Set(input.subjectIds);
  const bulk = await bulkNominations(driver, input);
  if (bulk.status === 'ok') {
    for (const nomination of bulk.nominations) {
      if (!subjects.has(nomination.leftId) && !subjects.has(nomination.rightId)) {
        continue;
      }
      const key = pairKey(nomination.leftId, nomination.rightId);
      const existing = nominated.get(key);
      nominated.set(key, {
        leftId: existing?.leftId ?? nomination.leftId,
        rightId: existing?.rightId ?? nomination.rightId,
        ...(existing?.nominatingCosine === undefined
          ? {}
          : { nominatingCosine: existing.nominatingCosine }),
        sharedEpisodeJaccard: nomination.sharedEpisodeJaccard,
      });
    }
  }

  const pairs = [...nominated.values()];
  await cache.require(pairs.flatMap((pair) => [pair.leftId, pair.rightId]));
  return orderNominations(
    pairs.filter((pair) => cache.isCurrent(pair.leftId) && cache.isCurrent(pair.rightId)),
  );
}

type Nominator = 'vector' | 'graph';

function otherNominator(nominator: Nominator): Nominator {
  return nominator === 'vector' ? 'graph' : 'vector';
}

function strengthOf(pair: NominatedPair, nominator: Nominator): number | undefined {
  return nominator === 'vector' ? pair.nominatingCosine : pair.sharedEpisodeJaccard;
}

/** One nominator's own list, strongest first, ties broken on the pair key so replays agree. */
function rankFor(pairs: readonly NominatedPair[], nominator: Nominator): NominatedPair[] {
  return pairs
    .filter((pair) => strengthOf(pair, nominator) !== undefined)
    .sort((left, right) => {
      const byStrength = (strengthOf(right, nominator) ?? 0) - (strengthOf(left, nominator) ?? 0);
      if (byStrength !== 0) {
        return byStrength;
      }
      return pairKey(left.leftId, left.rightId).localeCompare(pairKey(right.leftId, right.rightId));
    });
}

/**
 * The order a judge budget is spent in. Each nominator keeps its own ranking and the two take
 * turns, because the alternative ranks one above the other on a number the other never
 * produced: a cosine and a set-overlap ratio are not on one scale, and sorting on the cosine
 * first put every graph-only nomination below every vector one however strong the overlap was.
 *
 * That mattered in the measured direction. The highest name cosines on real data belong to
 * identifier-shaped traps (two digests differing in one byte), so a cosine-first budget was
 * handed the traps and starved the shared-episode nominations that carried the battery.
 */
export function orderNominations(pairs: readonly NominatedPair[]): NominatedPair[] {
  const queues: Record<Nominator, NominatedPair[]> = {
    vector: rankFor(pairs, 'vector'),
    graph: rankFor(pairs, 'graph'),
  };
  const taken = new Set<string>();
  const ordered: NominatedPair[] = [];

  const takeFrom = (nominator: Nominator): NominatedPair | undefined => {
    const queue = queues[nominator];
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined && !taken.has(pairKey(next.leftId, next.rightId))) {
        return next;
      }
    }
    return undefined;
  };

  let turn: Nominator = 'vector';
  while (ordered.length < pairs.length) {
    const next = takeFrom(turn) ?? takeFrom(otherNominator(turn));
    if (next === undefined) {
      break;
    }
    taken.add(pairKey(next.leftId, next.rightId));
    ordered.push(next);
    turn = otherNominator(turn);
  }

  // A pair no nominator claimed cannot reach here, since a nomination is what makes one. If the
  // shape ever changes it goes last rather than disappearing from the run without a word.
  return [...ordered, ...pairs.filter((pair) => !taken.has(pairKey(pair.leftId, pair.rightId)))];
}

/**
 * Tier 2. One read for every nominated pair; a pair whose signal row is missing keeps its
 * nomination and carries no graph evidence, which the fact prose states as an absence rather
 * than as a zero.
 */
export async function assembleEvidence(
  driver: Driver,
  pairs: readonly NominatedPair[],
): Promise<NominatedPair[]> {
  if (pairs.length === 0) {
    return [];
  }
  const measured = await readEntityPairSignals(
    driver,
    pairs.map((pair) => ({ leftId: pair.leftId, rightId: pair.rightId })),
  );
  const byKey = new Map(measured.map((signal) => [pairKey(signal.leftId, signal.rightId), signal]));
  return pairs.map((pair) => {
    const signals = byKey.get(pairKey(pair.leftId, pair.rightId));
    return signals === undefined ? pair : { ...pair, signals };
  });
}
