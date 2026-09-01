import { ENTITY_TYPES, isEntityType, type EntityType } from './entity-extraction.js';
import { foldName } from '../../infrastructure/providers/unicode-fold.js';

/**
 * What is left of `type` once identity stops depending on it, plus the second name key the
 * dedup cascade reads. Both are pure: the wiring that stores them lives with the write path.
 *
 * `type` is a label the graph carries, not a fact the model is trusted on once. One extractor
 * pass calls a referent a tool and the next calls it a topic, and under the old composite key
 * that disagreement minted a second node. Counted observations answer it instead: the label
 * follows the reading the extractor has given most often, and a change of label is a property
 * update. Counts, not a model-produced score, so there is no number here to threshold on.
 */

/**
 * How many times each reading has been observed for one entity, stored on the node as the
 * JSON string `type_counts`. Neo4j has no map property type, and a counted map spread across
 * one property per type would need a schema change per taxonomy edit.
 */
export type TypeCounts = Readonly<Partial<Record<EntityType, number>>>;

/**
 * The separators one identity gets spelled with. Stripping them is a lookup key, never a
 * uniqueness rule: `re-mark` and `remark` squash together and are two different words, so the
 * squash nominates a pair for the cascade to judge and decides nothing on its own.
 */
const SQUASHED_SEPARATORS = /[-_./ ]/g;

/**
 * Folds before squashing, so a caller holding a raw name and a caller holding `name_norm`
 * reach the same key. The fold is idempotent, which is what makes that safe.
 */
export function squashName(name: string): string {
  return foldName(name).replace(SQUASHED_SEPARATORS, '');
}

function isObservationCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Tolerant by construction: the property is absent on every entity written before this, and a
 * count under a type the taxonomy has dropped is stale vocabulary that must not win a
 * reconciliation. Either way an unreadable map is no observations, never a thrown read.
 */
export function parseTypeCounts(raw: unknown): TypeCounts {
  if (typeof raw !== 'string') {
    return {};
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return {};
  }

  const counts: Partial<Record<EntityType, number>> = {};
  for (const [type, count] of Object.entries(decoded)) {
    if (isEntityType(type) && isObservationCount(count)) {
      counts[type] = count;
    }
  }
  return counts;
}

/** Taxonomy order, so an unchanged map serializes to the same string and the write is a no-op. */
export function serializeTypeCounts(counts: TypeCounts): string {
  const ordered: Partial<Record<EntityType, number>> = {};
  for (const type of ENTITY_TYPES) {
    const count = counts[type];
    if (count !== undefined) {
      ordered[type] = count;
    }
  }
  return JSON.stringify(ordered);
}

/**
 * One extraction is one observation per distinct reading it gave, however many times it named
 * the entity. A model that repeats itself within a payload is not more evidence.
 */
export function recordTypeObservations(
  counts: TypeCounts,
  observed: readonly EntityType[],
): TypeCounts {
  const updated: Partial<Record<EntityType, number>> = { ...counts };
  for (const type of new Set(observed)) {
    updated[type] = (updated[type] ?? 0) + 1;
  }
  return updated;
}

/**
 * Most observed wins; a tie keeps the incumbent, so equal evidence never flips a label and two
 * extractions that disagree forever leave the first reading standing. Walking the taxonomy
 * rather than the map's own keys makes the answer independent of the order the JSON was
 * written in, which also settles a tie between two challengers.
 */
export function reconcileType(current: EntityType, observations: TypeCounts): EntityType {
  let winner = current;
  let best = observations[current] ?? 0;

  for (const type of ENTITY_TYPES) {
    const count = observations[type] ?? 0;
    if (count > best) {
      winner = type;
      best = count;
    }
  }

  return winner;
}
