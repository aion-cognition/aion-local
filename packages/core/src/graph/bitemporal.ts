import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import {
  type GraphStatement,
  inWriteTransaction,
  runWriteWithCounters,
} from './connection.js';
import { upsertEdgeInTransaction, type UpsertedEdge } from './edges.js';
import { GraphNodeNotFoundError } from './errors.js';
import { resolveLabels, type NodeLabel } from './labels.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphDateTime, toGraphParameters, type GraphProperties, type Row } from './values.js';

/**
 * PRD §5.5. World time is `valid_from`/`valid_until`, system time is `tx_from`/`tx_until`,
 * and `occurred_at` records when the experience itself happened. Open means the property is
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
   * The one true suppression. `aion forget` (P5) closes a node and stamps this; default
   * recall drops those rows while `as_of`/`knew_at` still return them, so the audit trail
   * survives an explicit forget.
   */
  forgottenAt: 'forgotten_at',
} as const;

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

export type StampedNodeWrite = StampNewInput & {
  /**
   * Applied on create and on match alike. Reserved for values that are constant for the
   * node's identity (the structural-entity upgrade of whitepaper §4.2); anything derived
   * from the clock belongs in `properties`, which only a creation writes.
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
 * label rule existed picks it up on the next write.
 */
export function buildStampedNodeWrite(input: StampedNodeWrite): GraphStatement {
  const stamped = stampNew(input);
  const companions = stamped.labels.filter((label) => label !== input.label);
  const labelClause = companions.length > 0 ? [`n:${companions.join(':')}`] : [];
  const mergeClause =
    input.mergeProperties === undefined ? [] : ['n += $mergeProperties'];
  const onMatch = [...labelClause, ...mergeClause];

  const cypher = [
    `MERGE (n:${input.label} { id: $id })`,
    `ON CREATE SET ${[...labelClause, 'n += $properties', ...mergeClause].join(', ')}`,
    ...(onMatch.length > 0 ? [`ON MATCH SET ${onMatch.join(', ')}`] : []),
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

export async function writeStampedNode(
  driver: Driver,
  input: StampedNodeWrite,
): Promise<StampedNodeResult> {
  const statement = buildStampedNodeWrite(input);
  const outcome = await runWriteWithCounters(driver, statement.cypher, statement.parameters, mapNodeRow);
  const row = outcome.rows[0];
  if (row === undefined) {
    throw new GraphNodeNotFoundError([String(statement.parameters.id)], 'stamped node write');
  }
  return { id: row.id, labels: row.labels, created: outcome.nodesCreated > 0 };
}

function mapNodeRow(row: Row): { id: string; labels: readonly string[] } {
  return { id: row.id as string, labels: row.labels as string[] };
}

export type SupersedeInput = {
  readonly oldId: string;
  readonly newId: string;
  readonly now?: Date;
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

const CLOSE_SUPERSEDED_NODE = [
  'MATCH (old { id: $oldId })',
  `SET old.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(old.${BITEMPORAL_PROPERTIES.validUntil}, $now),`,
  `    old.${BITEMPORAL_PROPERTIES.txUntil} = coalesce(old.${BITEMPORAL_PROPERTIES.txUntil}, $now)`,
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
  const now = input.now ?? new Date();

  return inWriteTransaction(driver, async (tx) => {
    const closed = await tx.run(
      CLOSE_SUPERSEDED_NODE,
      { oldId: input.oldId, now: toGraphDateTime(now) },
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
  });
}
