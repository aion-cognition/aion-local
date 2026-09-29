import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import {
  type GraphStatement,
  type GraphTransaction,
  type WriteOutcome,
  inWriteTransaction,
  runWrite,
  runWriteWithCounters,
} from './connection.js';
import { upsertEdgeInTransaction, type UpsertedEdge } from './edges.js';
import { GraphNodeNotFoundError } from './errors.js';
import {
  BASE_NODE_LABEL,
  matchedCompanionLabels,
  resolveLabels,
  type NodeLabel,
} from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphDateTime, toGraphParameters, type GraphProperties, type Row } from './values.js';

/**
 * World time is `valid_from`/`valid_until`, system time is `tx_from`/`tx_until`, and
 * `occurred_at` records when the experience itself happened. Open means the property is
 * absent: Cypher has no null property value, so an open interval is written by leaving the
 * field off, and every read predicate tests `IS NULL` accordingly.
 */
export const BITEMPORAL_PROPERTIES = {
  occurredAt: 'occurred_at',
  validFrom: 'valid_from',
  validUntil: 'valid_until',
  txFrom: 'tx_from',
  txUntil: 'tx_until',
  /**
   * The one true suppression. `aion forget` closes a node and stamps this; default
   * recall drops those rows while `as_of`/`knew_at` still return them, so the audit trail
   * survives an explicit forget.
   */
  forgottenAt: 'forgotten_at',
  /**
   * How many lifecycle transitions this row has been through, advanced by the writer that
   * performs each one.
   *
   * A reader that needs to know whether a row's lifecycle MOVED cannot ask its timestamps: a
   * caller supplies the clock, so a reopen and a reclose under the same value put every stamp
   * back where it was and the row reads as though nothing happened. The counter only goes
   * forward, so the two states are different whatever the clocks say.
   */
  lifecycleRevision: 'lifecycle_rev',
} as const;

/** A node is current when open in both world time and system time: neither superseded nor forgotten. */
export function currentOnly(variable: string): string {
  return [
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `${variable}.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  ].join(' AND ');
}

/**
 * Which maintenance operation closed a node, set only by a close that a later mention should
 * undo. `aion forget` (`forgetNode`, `forgotten_at` alone) and a merge absorb
 * (`supersedeInTransaction`'s `closeFragment` alone) never write it, because neither close is
 * provisional: a person's forget stands until a person reverses it, and an absorbed duplicate's
 * identity is the surviving node, not this one. `identifier_decay` writes it precisely because
 * its close is a bet on silence rather than a verdict, and `entity-queries.ts`'s `buildEntityMerge`
 * reads it to tell the two apart before deciding whether the next mention reopens the node.
 *
 * `intention_upkeep` writes it for the provenance alone. Its close is the same bet on silence,
 * but nothing reopens a cognitive node on a mention the way `buildEntityMerge` reopens an
 * entity, so on a Goal or a Plan the stamp records which operation closed it and `aion
 * unsupersede` is the undo.
 */
export const CLOSURE_PROVENANCE_PROPERTY = 'closed_by';

export type StampNewInput = {
  readonly label: NodeLabel;
  readonly id?: string;
  readonly properties?: GraphProperties;
  /** When the experience happened; defaults to now. Also the default `valid_from`. */
  readonly occurredAt?: Date;
  readonly validFrom?: Date;
  readonly now?: Date;
};

export type StampedNode = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly properties: GraphProperties;
};

/**
 * The stamp every node write carries. Pure, so batch writers can stamp many nodes against
 * one clock reading and callers can assert the shape without a server.
 */
export function stampNew(input: StampNewInput): StampedNode {
  const now = input.now ?? new Date();
  const occurredAt = input.occurredAt ?? now;
  const id = input.id ?? randomUUID();
  return {
    id,
    labels: resolveLabels(input.label),
    properties: {
      ...input.properties,
      id,
      [BITEMPORAL_PROPERTIES.occurredAt]: occurredAt,
      [BITEMPORAL_PROPERTIES.validFrom]: input.validFrom ?? occurredAt,
      [BITEMPORAL_PROPERTIES.txFrom]: now,
    },
  };
}

/**
 * The stamp a node derived from an experience takes. `occurredAt` is required here and
 * optional on `StampNewInput`, because a derived node's world time is the world time of what
 * it was derived from: defaulting it to the write clock dates a replayed episode's structure
 * to the replay. A backbone node, which is derived from nothing, keeps the looser type.
 */
export type StampDerivedInput = Omit<StampNewInput, 'occurredAt'> & { readonly occurredAt: Date };

export function stampDerived(input: StampDerivedInput): StampedNode {
  return stampNew(input);
}

export type StampedNodeWrite = StampNewInput & {
  /**
   * Applied on create and on match alike: the structural-entity upgrade, and singleton
   * attributes a later run may correct. Anything derived from the clock belongs in
   * `properties`, which only a creation writes.
   */
  readonly mergeProperties?: GraphProperties;
};

export type StampedNodeResult = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly created: boolean;
};

/**
 * MERGE on the primary label and id, and never rewrite the stamp on match: a second
 * identical write is a no-op, and a changed fact is a supersession rather than an
 * overwrite. Companion labels are applied on both branches so a node written before a
 * label rule existed picks it up on the next write, except onto a node that wears the
 * primary label as a companion of its own (`matchedCompanionLabels`).
 */
export function buildStampedNodeWrite(input: StampedNodeWrite): GraphStatement {
  const stamped = stampNew(input);
  const companions = stamped.labels.filter((label) => label !== input.label);
  const labelClause = companions.length > 0 ? [`n:${companions.join(':')}`] : [];
  const matched = matchedCompanionLabels('n', input.label);
  const mergeClause = input.mergeProperties === undefined ? [] : ['n += $mergeProperties'];
  const onMatch = [`n:${matched.set.join(':')}`, ...mergeClause];

  const cypher = [
    `MERGE (n:${input.label} { id: $id })`,
    `ON CREATE SET ${[...labelClause, 'n += $properties', ...mergeClause].join(', ')}`,
    `ON MATCH SET ${onMatch.join(', ')}`,
    ...(matched.guarded === undefined ? [] : [matched.guarded]),
    'RETURN n.id AS id, labels(n) AS labels',
  ].join('\n');

  return {
    cypher,
    parameters: {
      id: stamped.properties.id,
      properties: toGraphParameters(stamped.properties),
      ...(input.mergeProperties === undefined
        ? {}
        : { mergeProperties: toGraphParameters(input.mergeProperties) }),
    },
  };
}

function toStampedNodeResult(
  statement: GraphStatement,
  outcome: WriteOutcome<{ id: string; labels: readonly string[] }>,
): StampedNodeResult {
  const row = outcome.rows[0];
  if (row === undefined) {
    throw new GraphNodeNotFoundError([String(statement.parameters.id)], 'stamped node write');
  }
  return { id: row.id, labels: row.labels, created: outcome.nodesCreated > 0 };
}

export async function writeStampedNode(
  driver: Driver,
  input: StampedNodeWrite,
): Promise<StampedNodeResult> {
  const statement = buildStampedNodeWrite(input);
  const outcome = await runWriteWithCounters(
    driver,
    statement.cypher,
    statement.parameters,
    mapNodeRow,
  );
  return toStampedNodeResult(statement, outcome);
}

/** Same write inside a caller's transaction, for the paths that must stamp several nodes atomically. */
export async function writeStampedNodeInTransaction(
  tx: GraphTransaction,
  input: StampedNodeWrite,
): Promise<StampedNodeResult> {
  const statement = buildStampedNodeWrite(input);
  const outcome = await tx.runWithCounters(statement.cypher, statement.parameters, mapNodeRow);
  return toStampedNodeResult(statement, outcome);
}

export type StampedDerivedWrite = StampDerivedInput & {
  readonly mergeProperties?: GraphProperties;
};

/** The same transaction write, narrowed so a derived node cannot reach the graph without its world time. */
export async function writeStampedDerivedNodeInTransaction(
  tx: GraphTransaction,
  input: StampedDerivedWrite,
): Promise<StampedNodeResult> {
  return writeStampedNodeInTransaction(tx, input);
}

function mapNodeRow(row: Row): { id: string; labels: readonly string[] } {
  return { id: row.id as string, labels: row.labels as string[] };
}

export type SupersedeInput = {
  readonly oldId: string;
  readonly newId: string;
  readonly now?: Date;
  /**
   * When the correcting experience happened, which is when the old fact stopped being true.
   * Defaults to `now` for a close whose reason is the write itself, such as a maintenance
   * sweep or a person's correction.
   */
  readonly validUntil?: Date;
  readonly signals?: readonly string[];
  readonly provenance?: readonly string[];
};

export type SupersedeResult = {
  readonly oldId: string;
  readonly newId: string;
  readonly validUntil: Date;
  readonly txUntil: Date;
  readonly edge: UpsertedEdge;
};

/**
 * The `SET` clause every close writes, `coalesce`d so a repeat close keeps the first call's
 * timestamps rather than pushing them later. The two timelines bind separate parameters: a
 * fact stops being true when the experience that corrected it happened, and stops being what
 * the substrate holds at the moment of the write, and those are the same value only when the
 * correction is the write. A caller with one clock for both binds it twice.
 */
export function closeFragment(variable: string): string {
  return [
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(${variable}.${BITEMPORAL_PROPERTIES.validUntil}, $validUntil)`,
    `${variable}.${BITEMPORAL_PROPERTIES.txUntil} = coalesce(${variable}.${BITEMPORAL_PROPERTIES.txUntil}, $txUntil)`,
  ].join(',\n    ');
}

/**
 * The counter a lifecycle transition advances, in the statement that performs the transition.
 *
 * `when` is the writer's own test for "this row is actually moving", so a repeated close and a
 * restatement of an open row leave the number alone: a version that advanced on a no-op would
 * void every window that rests on it. It is written before the stamps it counts, because a SET
 * that had already moved them would be testing its own write.
 */
export function advanceLifecycleRevision(variable: string, when: string): string {
  const property = `${variable}.${BITEMPORAL_PROPERTIES.lifecycleRevision}`;
  return `${property} = CASE WHEN ${when} THEN coalesce(${property}, 0) + 1 ELSE ${property} END`;
}

/**
 * The close a RELATIONSHIP takes: the two stamps, and the counter that says the row moved.
 *
 * Relationships carry it and nodes do not, because the reader is the association history a
 * qualification window rests on. A close that only wrote stamps could be undone and redone under
 * one supplied clock and leave that history reading exactly as it did before.
 */
export function closeRelationshipFragment(variable: string): string {
  const open = [
    `${variable}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `${variable}.${BITEMPORAL_PROPERTIES.txUntil} IS NULL`,
  ].join(' OR ');
  return [advanceLifecycleRevision(variable, open), closeFragment(variable)].join(',\n    ');
}

const CLOSE_SUPERSEDED_NODE = [
  `MATCH (old:${BASE_NODE_LABEL} { id: $oldId })`,
  `SET ${closeFragment('old')}`,
  `RETURN old.id AS id, old.${BITEMPORAL_PROPERTIES.validUntil} AS validUntil,`,
  `       old.${BITEMPORAL_PROPERTIES.txUntil} AS txUntil`,
].join('\n');

/**
 * Closes both timelines on the old node and links `(new)-[:SUPERSEDES]->(old)` in one
 * transaction, so a closed node without lineage is not a state the substrate can reach.
 * `coalesce` on the close keeps the first supersession's timestamps, and the lineage edge
 * carries count 0, which together make a repeated call a total no-op. The old node is
 * never deleted: it stays recall-eligible and time-travel-visible.
 */
export async function supersede(driver: Driver, input: SupersedeInput): Promise<SupersedeResult> {
  return inWriteTransaction(driver, async (tx) => supersedeInTransaction(tx, input));
}

/**
 * The same close-and-link, joined to a transaction the caller already holds. Entity dedup
 * needs it: the merge must be atomic, so redirecting a duplicate's edges and closing the
 * duplicate have to commit or roll back together. Splitting them leaves a window where the
 * node is stripped of its relationships and still marked current, a live-looking entity with
 * nothing attached, which name and KNN search both still return.
 */
export async function supersedeInTransaction(
  tx: GraphTransaction,
  input: SupersedeInput,
): Promise<SupersedeResult> {
  const now = input.now ?? new Date();
  const validUntil = input.validUntil ?? now;

  const closed = await tx.run(
    CLOSE_SUPERSEDED_NODE,
    {
      oldId: input.oldId,
      validUntil: toGraphDateTime(validUntil),
      txUntil: toGraphDateTime(now),
    },
    (row) => ({
      id: row.id as string,
      validUntil: row.validUntil as Date,
      txUntil: row.txUntil as Date,
    }),
  );
  const old = closed[0];
  if (old === undefined) {
    throw new GraphNodeNotFoundError([input.oldId], 'supersede');
  }

  const edge = await upsertEdgeInTransaction(tx, {
    type: SUPERSEDES_TYPE,
    sourceId: input.newId,
    targetId: input.oldId,
    strength: 1,
    confidence: 1,
    signals: input.signals ?? ['bitemporal'],
    provenance: input.provenance ?? ['supersede'],
    count: 0,
    now,
  });

  return {
    oldId: old.id,
    newId: input.newId,
    validUntil: old.validUntil,
    txUntil: old.txUntil,
    edge,
  };
}

export type ForgetNodeInput = {
  readonly id: string;
  readonly now?: Date;
};

export type ForgetNodeResult = {
  readonly id: string;
  readonly forgottenAt: Date;
  /** False on a repeated forget: the first call's timestamp stands. */
  readonly justForgotten: boolean;
};

const FORGET_NODE = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `SET n.${BITEMPORAL_PROPERTIES.forgottenAt} = coalesce(n.${BITEMPORAL_PROPERTIES.forgottenAt}, $now)`,
  `RETURN n.id AS id, n.${BITEMPORAL_PROPERTIES.forgottenAt} AS forgottenAt,`,
  `       n.${BITEMPORAL_PROPERTIES.forgottenAt} = $now AS justForgotten`,
].join('\n');

function mapForgetRow(row: Row): ForgetNodeResult {
  return {
    id: row.id as string,
    forgottenAt: row.forgottenAt as Date,
    justForgotten: row.justForgotten === true,
  };
}

/**
 * `aion forget`'s write: the one true suppression, and the only bitemporal close that touches
 * no other node. `coalesce` keeps the first forget's timestamp, so a repeated call is a no-op
 * on the stamp. Nothing is deleted; `as_of`/`knew_at` reads still return the row
 * (`read-modes.ts`), which is what makes the audit trail survive an explicit forget.
 */
export async function forgetNode(
  driver: Driver,
  input: ForgetNodeInput,
): Promise<ForgetNodeResult> {
  const now = input.now ?? new Date();
  const rows = await runWrite(
    driver,
    FORGET_NODE,
    { id: input.id, now: toGraphDateTime(now) },
    mapForgetRow,
  );
  const row = rows[0];
  if (row === undefined) {
    throw new GraphNodeNotFoundError([input.id], 'forget');
  }
  return row;
}

/**
 * The same stamp inside a caller's transaction, which is where the guarded writer runs it. A
 * suppression and the durable statement recording it have to land under one receipt, and a
 * second transaction opened underneath the guard would commit outside it.
 */
export async function forgetNodeInTransaction(
  tx: GraphTransaction,
  input: ForgetNodeInput & { readonly now: Date },
): Promise<ForgetNodeResult | undefined> {
  const rows = await tx.run(
    FORGET_NODE,
    { id: input.id, now: toGraphDateTime(input.now) },
    mapForgetRow,
  );
  return rows[0];
}

export type UnforgetNodeResult = {
  readonly id: string;
  /** False when the node carried no stamp, which makes a repeated unforget a no-op. */
  readonly justUnforgotten: boolean;
};

/**
 * Dropping the suppression stamp, on `unsupersede`'s pattern rather than by writing a later
 * interval: an unforget means the node is servable again, and `REMOVE` is what default recall
 * reads. The supersession stamps are untouched, the mirror image of the rule
 * `RESTORE_CURRENCY` states — a close and a forget are separate acts, and undoing one is not
 * consent to undo the other.
 */
const UNFORGET_NODE = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `WITH n, n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NOT NULL AS wasForgotten`,
  `REMOVE n.${BITEMPORAL_PROPERTIES.forgottenAt}`,
  'RETURN n.id AS id, wasForgotten',
].join('\n');

export async function unforgetNodeInTransaction(
  tx: GraphTransaction,
  input: ForgetNodeInput,
): Promise<UnforgetNodeResult | undefined> {
  const rows = await tx.run(UNFORGET_NODE, { id: input.id }, (row) => ({
    id: row.id as string,
    justUnforgotten: row.wasForgotten === true,
  }));
  return rows[0];
}

export type NodeSuppressionState = {
  readonly present: boolean;
  readonly forgotten: boolean;
};

const READ_SUPPRESSION_STATE = [
  `MATCH (n:${BASE_NODE_LABEL} { id: $id })`,
  `RETURN n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NOT NULL AS forgotten`,
].join('\n');

/**
 * What the guard sees about the stamp before it decides. Read inside the operation's own
 * transaction rather than carried from the command, because a suppression taken on a reading
 * from before the guard is a decision about a node that may have moved since.
 */
export async function suppressionStateInTransaction(
  tx: GraphTransaction,
  id: string,
): Promise<NodeSuppressionState> {
  const rows = await tx.run(READ_SUPPRESSION_STATE, { id }, (row) => row.forgotten === true);
  const forgotten = rows[0];
  return forgotten === undefined
    ? { present: false, forgotten: false }
    : { present: true, forgotten };
}
