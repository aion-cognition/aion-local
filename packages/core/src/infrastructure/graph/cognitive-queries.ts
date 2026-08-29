import { createHash } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import type { Vector } from '../providers/types.js';
import { writeStampedNodeInTransaction, type StampedNodeResult } from './bitemporal.js';
import { inWriteTransaction } from './connection.js';
import { upsertEdgeInTransaction, type UpsertedEdge } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import type { NodeLabel } from './labels.js';
import { toGraphVector, type GraphProperties } from './values.js';

/**
 * Whitepaper §6.7's nine cognitive types. This module is their only writer.
 */
export const COGNITIVE_NODE_LABELS = [
  'Goal',
  'Plan',
  'Decision',
  'Insight',
  'Concept',
  'Context',
  'Event',
  'Pattern',
  'Trend',
] as const satisfies readonly NodeLabel[];

export type CognitiveNodeLabel = (typeof COGNITIVE_NODE_LABELS)[number];

export function isCognitiveNodeLabel(value: string): value is CognitiveNodeLabel {
  return (COGNITIVE_NODE_LABELS as readonly string[]).includes(value);
}

/** Stored alongside `text` so a future reader can match on it without recomputing the fold. */
export const TEXT_NORM_PROPERTY = 'text_norm';

/** Collapses whitespace and lowercases, matching `backbone.ts`'s entity-name normalization. */
export function normalizeCognitiveText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Node identity: (source episode, cognitive type, normalized text). A deterministic id
 * folded from the three is the whole idempotency mechanism — `writeStampedNode`'s `(label,
 * id)` MERGE matches the same id on a re-run instead of creating a duplicate, so extracting
 * the same node from the same episode twice is a no-op. This trades the usual
 * random-id-plus-lookup-query pattern (`episodes.ts`'s content hash) for one with no read
 * before the write and no new query shape for a test fixture to model.
 *
 * The separator is a NUL, which no id, label, or normalized text can contain, so two
 * different triples cannot fold to one string. It is written as the `\u0000` escape rather
 * than as the byte itself: a literal NUL in the source makes git read the whole file as
 * binary and drop diff, blame, and text search for it.
 */
export function deriveCognitiveNodeId(
  episodeId: string,
  label: CognitiveNodeLabel,
  textNorm: string,
): string {
  return createHash('sha256').update(`${episodeId}\u0000${label}\u0000${textNorm}`).digest('hex');
}

/**
 * Section 6.7's "keep it modest": only the fields called out per type. Everything else rides
 * on `text` alone. A field left undefined here is dropped before the write, never stored as
 * null (`values.ts`'s `toGraphParameters`).
 */
export type CognitiveNodeMetadata = {
  readonly status?: string;
  readonly priority?: string;
  readonly rationale?: string;
};

export type CognitiveNodeWrite = {
  readonly episodeId: string;
  readonly label: CognitiveNodeLabel;
  readonly text: string;
  readonly metadata?: CognitiveNodeMetadata;
  /** Absent on an embed failure: the node lands without `content_vec`, the same pending-vector marker intake leaves on its own outage path. */
  readonly contentVector?: Vector;
  /** Defaults to `now`: an episode with no `occurred_at` of its own has no better world-time to give the structure extracted from it. */
  readonly occurredAt?: Date;
  readonly now: Date;
};

export type CognitiveNodeWriteResult = {
  readonly node: StampedNodeResult;
  readonly edge: UpsertedEdge;
  /** False when the id already existed: a prior run (or an earlier node in this one) wrote it first. */
  readonly created: boolean;
};

/**
 * The node write and its `EXTRACTED_FROM` provenance edge in one transaction, so a crash
 * between the two never leaves a cognitive node with no source. `count: 0` on the edge makes
 * the link itself a total no-op on re-run, matching `supersede()`'s `SUPERSEDES` edge: this
 * is structural provenance, not an observation to tally.
 */
export async function writeCognitiveNode(
  driver: Driver,
  input: CognitiveNodeWrite,
): Promise<CognitiveNodeWriteResult> {
  const textNorm = normalizeCognitiveText(input.text);
  const id = deriveCognitiveNodeId(input.episodeId, input.label, textNorm);

  const properties: GraphProperties = {
    [MEMORY_PROPERTIES.text]: input.text,
    [TEXT_NORM_PROPERTY]: textNorm,
    status: input.metadata?.status,
    priority: input.metadata?.priority,
    rationale: input.metadata?.rationale,
    ...(input.contentVector === undefined
      ? {}
      : { [MEMORY_PROPERTIES.contentVector]: toGraphVector(input.contentVector) }),
  };

  return inWriteTransaction(driver, async (tx) => {
    const node = await writeStampedNodeInTransaction(tx, {
      label: input.label,
      id,
      now: input.now,
      occurredAt: input.occurredAt ?? input.now,
      properties,
    });

    const edge = await upsertEdgeInTransaction(tx, {
      type: 'EXTRACTED_FROM',
      sourceId: id,
      targetId: input.episodeId,
      strength: 1,
      confidence: 1,
      signals: ['reflection'],
      provenance: ['cognitive-extraction'],
      count: 0,
      now: input.now,
    });

    return { node, edge, created: node.created };
  });
}
