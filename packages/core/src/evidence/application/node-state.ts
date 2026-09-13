import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  readScopeMirror,
  recordScopeMirror,
  rejectScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { GRAPH_NODE_SCOPE } from '../domain/scopes.js';

/**
 * The counter that says which reading of a node's own semantic state a judgment was made on.
 *
 * Two acts, and every writer of a retained node performs one of them. The write that MINTS a node
 * establishes the census: the id was drawn by that write, so nothing else has ever said anything
 * about this node and the population behind the counter is whole because it is this write's own.
 * Every later writer that changes the node's relevant state ADVANCES it, which is what stops a
 * judgment fenced on the reading that writer invalidated from still verifying as current.
 *
 * Establishing is not advancing with a flag. A node that is counted from birth never passes through
 * the state where its counter has moved and nobody has counted it, which is the state
 * `readRelationScope` refuses and the state every judged pair used to sit in.
 *
 * The mirror carries the same number as the census. The scope's authority is the graph, so a reader
 * takes its version from the mirror rather than from the published revision, and a writer that
 * moved one without the other would leave a reader's token pinned to a state that has moved.
 */

/** The scopes the judged reads ask about a node, filed where the registry files them. */
export function nodeStateScope(nodeId: string): { endpointId: string; relationClass: string } {
  return { endpointId: nodeId, relationClass: GRAPH_NODE_SCOPE };
}

/**
 * Parks the first number on a node the caller is about to mint, inside a durable prepare.
 *
 * Nothing else can hold the pending slot: the id belongs to this operation and no other operation
 * has ever seen it.
 */
export function prepareMintedNodeState(
  db: SqliteHandle,
  nodeId: string,
  operationId: string,
  observedAt: Date,
): void {
  prepareScopeAdvance(db, { ...nodeStateScope(nodeId), operationId, updatedAt: observedAt });
}

/**
 * Establishes the census and records the reading it was established at, inside the acknowledgment.
 *
 * Both halves or neither. A census with no mirror leaves a graph-authority scope unreadable, and a
 * mirror with no census is a number nobody counted.
 */
export function acknowledgeMintedNodeState(
  db: SqliteHandle,
  nodeId: string,
  operationId: string,
  knownFrom: string,
): boolean {
  const published = acknowledgeScopeAdvance(db, {
    ...nodeStateScope(nodeId),
    operationId,
    updatedAt: new Date(knownFrom),
    censusStatus: 'established',
    coverageJson: JSON.stringify({ basis: 'minted_identity', nodeId, knownFrom }),
  });
  if (published === undefined) {
    return false;
  }
  recordScopeMirror(db, {
    ...nodeStateScope(nodeId),
    mirroredRevision: published,
    operationId,
    mirroredAt: new Date(knownFrom),
  });
  return true;
}

/** Releases the parked number. Nothing was published, so no reader's token moved. */
export function discardMintedNodeState(
  db: SqliteHandle,
  nodeId: string,
  operationId: string,
  observedAt: Date,
): void {
  rejectScopeAdvance(db, { ...nodeStateScope(nodeId), operationId, updatedAt: observedAt });
}

/**
 * Moves the counter for a node whose semantic state this operation changed.
 *
 * Called from the acknowledgment that made the change, so evidence somebody else is holding about
 * that state stops being current in the operation that moved it rather than whenever a sweep next
 * looks. It never claims a census: a writer that changed one node has counted no population, and a
 * node that reaches here without one was minted before anything counted it and keeps its gap.
 */
export function advanceNodeState(
  db: SqliteHandle,
  nodeId: string,
  operationId: string,
  knownFrom: string,
): void {
  const held = readScopeMirror(db, nodeStateScope(nodeId));
  recordScopeMirror(db, {
    ...nodeStateScope(nodeId),
    mirroredRevision: (held?.mirroredRevision ?? 0) + 1,
    operationId,
    mirroredAt: new Date(knownFrom),
  });
}
