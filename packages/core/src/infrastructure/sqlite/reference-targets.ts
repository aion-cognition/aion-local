import type { SqliteHandle } from './database.js';
import { sourcePartAddress } from './source-identity.js';
import { sourceResidencyState } from './source-lifecycle.js';

/**
 * What a stated reference names.
 *
 * The occurrence contract alone only finds sources, and a caller states references against more
 * than sources: a turn or another part of one, a retained interpretation the graph holds, or an
 * id the substrate has never seen. Each of those is a different answer, and collapsing them
 * would make an absent projection indistinguishable from an unknown identity.
 *
 * The distinction that matters most is the last one. A verified source whose raw projection is
 * gone is KNOWN: the reference resolves, and it is recorded against the original identity. Only
 * an id nothing accounts for stays unresolved, and it stays durably stated while it does.
 */
export type ReferenceTargetClass = 'source' | 'part' | 'retained_node' | 'unresolved';

export type ReferenceTarget = {
  readonly id: string;
  readonly targetClass: ReferenceTargetClass;
  /** The source the target belongs to, for a source or one of its parts. */
  readonly sourceId?: string;
  /** Where that source's raw projection sits, which decides whether a graph edge is writable. */
  readonly residency?: 'resident' | 'retiring' | 'evicted';
};

type PartRow = { source_id: string; part_kind: string; ordinal: number };

/**
 * The part an address or an original turn id names. Both forms are accepted: a caller citing a
 * part uses the canonical `part:` encoding, and one citing a Turn it was served uses the id the
 * graph minted.
 */
function partTarget(db: SqliteHandle, id: string): ReferenceTarget | undefined {
  const byTurn = db
    .prepare('SELECT source_id, part_kind, ordinal FROM source_parts WHERE turn_id = ? LIMIT 1')
    .get(id) as PartRow | undefined;
  if (byTurn !== undefined) {
    return { id, targetClass: 'part', sourceId: byTurn.source_id };
  }
  const [prefix, sourceId, partKind, ordinal] = id.split(':');
  if (prefix !== 'part' || sourceId === undefined || partKind === undefined) {
    return undefined;
  }
  const row = db
    .prepare(
      'SELECT source_id, part_kind, ordinal FROM source_parts WHERE source_id = ? AND part_kind = ? AND ordinal = ?',
    )
    .get(sourceId, partKind, Number(ordinal)) as PartRow | undefined;
  if (row === undefined || sourcePartAddress(sourceId, partKind, row.ordinal) !== id) {
    return undefined;
  }
  return { id, targetClass: 'part', sourceId };
}

/**
 * Classifies one stated target against the durable records. The graph is asked only about ids
 * these records do not account for, which is what keeps an evicted source from reading as an
 * unknown identity.
 */
export function classifyReferenceTarget(
  db: SqliteHandle,
  id: string,
  retainedNodeIds: ReadonlySet<string>,
): ReferenceTarget {
  const source = db.prepare('SELECT source_id FROM source_records WHERE source_id = ?').get(id) as
    { source_id: string } | undefined;
  if (source !== undefined) {
    return {
      id,
      targetClass: 'source',
      sourceId: id,
      residency: sourceResidencyState(db, id),
    };
  }
  const part = partTarget(db, id);
  if (part !== undefined) {
    return { ...part, residency: sourceResidencyState(db, part.sourceId ?? '') };
  }
  if (retainedNodeIds.has(id)) {
    return { id, targetClass: 'retained_node' };
  }
  return { id, targetClass: 'unresolved' };
}
