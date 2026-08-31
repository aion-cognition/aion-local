import {
  closeIdentifierEntities,
  findIdentifierDecayCandidates,
  type IdentifierDecayCandidate,
} from '../../../infrastructure/graph/identifier-decay-queries.js';
import type { HealthSnapshot } from '../../domain/health.js';
import { identifierShape, type IdentifierShape } from '../../domain/identifier-shape.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

/**
 * `identifier_decay` closes the identifier-shaped entities (a commit SHA, a UUID, a file path,
 * a subagent id) that nothing ages today. Each one carries the same
 * MENTIONS/CO_OCCURS fan-out any other entity does, and every session adds more of them, which
 * is unbounded growth in exactly the node class recall least needs.
 *
 * Acts from day one, gated by the `identifierDecay` kill switch: off leaves every
 * identifier-shaped entity exactly as it is today. Closing is bitemporal
 * (`identifier-decay-queries.ts` states which primitives it reuses), never a delete. The undo
 * story here is `edge_prune`'s, not `aion forget`'s: a decayed identifier returns to fully
 * current the moment anything mentions it again, because the close stamps `closed_by`
 * (`bitemporal.ts`), which `entity-queries.ts`'s `buildEntityMerge` reads on the next MERGE and
 * clears along with the rest of the closed timeline. A node `aion forget` closed carries no such
 * marker, so the same mention leaves it exactly as forgotten as it was.
 */

export const IDENTIFIER_DECAY_OPERATION = 'identifier_decay';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * No health collector counts identifier-shaped entities specifically, so this reads the same
 * coarse way `edge_prune` does off a total that is zero only when the narrower population is:
 * `health.graph.nodes` is zero only on an empty substrate, and an empty substrate holds no
 * identifier-shaped entity either. Above that gate the value is a floor on urgency, not a
 * measurement of how much stale identifier mass is actually waiting; a dedicated collector
 * would replace it, and none exists today.
 */
export const IDENTIFIER_DECAY_STANDING_RELEVANCE = 0.1;

export function identifierDecayRelevance(health: HealthSnapshot): number {
  if (health.graph.nodes <= 0) {
    return 0;
  }
  return IDENTIFIER_DECAY_STANDING_RELEVANCE;
}

function daysSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / DAY_MS;
}

/**
 * Unprotected, identifier-shaped, and unmentioned for at least the half-life. A candidate with
 * no current mention edge at all (`lastMentionAt` absent) is left alone rather than treated as
 * infinitely stale: every entity is mentioned at the episode that creates it
 * (`entities.ts`'s `linkEntityMentions`), so an absent stamp reads as a state this scan should
 * not guess about rather than as an old one.
 */
function isEligible(
  candidate: IdentifierDecayCandidate,
  shape: IdentifierShape,
  now: Date,
  halfLifeDays: number,
  mentionFloor: number,
): boolean {
  if (shape === 'none') {
    return false;
  }
  if (candidate.isMergeCanonicalTarget || candidate.hasTypedKnowledgeEdge) {
    return false;
  }
  if (candidate.episodeMentions > mentionFloor) {
    return false;
  }
  if (candidate.lastMentionAt === undefined) {
    return false;
  }
  return daysSince(candidate.lastMentionAt, now) >= halfLifeDays;
}

function shapeSummary(counts: ReadonlyMap<IdentifierShape, number>): string {
  return [...counts.entries()]
    .filter(([, count]) => count > 0)
    .map(([shape, count]) => `${String(count)} ${shape}`)
    .join(', ');
}

async function runIdentifierDecay(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.identifierDecay) {
    return {
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail:
        'identifier decay disabled by AION_MAINTENANCE_IDENTIFIER_DECAY; no entities examined',
    };
  }

  const { identifierDecayBatch, identifierHalfLifeDays, identifierMentionFloor } =
    ctx.config.maintenance;
  const candidates = await findIdentifierDecayCandidates(ctx.driver, identifierDecayBatch);

  const counts = new Map<IdentifierShape, number>();
  const eligibleIds: string[] = [];
  for (const candidate of candidates) {
    const shape = identifierShape(candidate.name, candidate.type);
    if (!isEligible(candidate, shape, ctx.now, identifierHalfLifeDays, identifierMentionFloor)) {
      continue;
    }
    eligibleIds.push(candidate.id);
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }

  if (eligibleIds.length === 0) {
    return {
      status: 'noop',
      itemsProcessed: candidates.length,
      itemsAffected: 0,
      detail: `0 of ${String(candidates.length)} scanned entities eligible to close`,
    };
  }

  const closed = await closeIdentifierEntities(ctx.driver, eligibleIds, ctx.now);
  const mentionsClosed = closed.reduce((sum, entry) => sum + entry.mentionsClosed, 0);
  const coOccursClosed = closed.reduce((sum, entry) => sum + entry.coOccursClosed, 0);

  return {
    status: 'applied',
    itemsProcessed: candidates.length,
    itemsAffected: closed.length,
    detail:
      `closed ${String(closed.length)} identifier entit${closed.length === 1 ? 'y' : 'ies'} ` +
      `(${shapeSummary(counts)}) of ${String(candidates.length)} scanned; ` +
      `${String(mentionsClosed)} MENTIONS and ${String(coOccursClosed)} CO_OCCURS edge(s) closed with them`,
  };
}

/**
 * `identifierDecayBatch` defaults to 500: every current entity is read regardless of shape, so
 * the batch bounds the scan rather than the (usually much smaller) close.
 */
export function identifierDecayOperation(): IntrospectionOperation {
  return {
    name: IDENTIFIER_DECAY_OPERATION,
    bucket: 'day',
    relevance: identifierDecayRelevance,
    run: runIdentifierDecay,
  };
}
