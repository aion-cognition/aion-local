import type { Driver } from 'neo4j-driver';
import { createHash } from 'node:crypto';

import { writeStampedDerivedNodeInTransaction, type StampedNodeResult } from './bitemporal.js';
import {
  claimKeyProperties,
  closeKeyedClaimsInTransaction,
  type KeyedCloseOptions,
  type KeyedCloseResult,
} from './claim-key-queries.js';
import { normalizeCognitiveText, TEXT_NORM_PROPERTY } from './cognitive-text.js';
import { inWriteTransaction } from './connection.js';
import { upsertEdgeInTransaction, type UpsertedEdge } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { intentionProperties, type IntentionOriginKind } from './intention-queries.js';
import type { NodeLabel } from './labels.js';
import { toGraphVector, type GraphProperties } from './values.js';
import type { TemporalClass } from '../../reflection/domain/claim-key.js';
import { vectorInputHash } from '../../reflection/domain/vector-input.js';
import type { Vector } from '../providers/types.js';

/** The stored fold declares itself below this module, and every reader of it still asks here. */
export { normalizeCognitiveText, TEXT_NORM_PROPERTY };

/**
 * The nine cognitive node types the reflection pipeline extracts. This module is their
 * only writer.
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

/**
 * Node identity: (source episode, cognitive type, normalized text). A deterministic id
 * folded from the three is the whole idempotency mechanism: `writeStampedNode`'s `(label,
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
 * Kept modest on purpose: only the fields called out per type. Everything else rides
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
  /**
   * The world time of the episode this was extracted from. Required rather than defaulted:
   * a node that silently took the write clock dates a replayed episode's structure to the
   * replay, and the caller is the only one that knows the episode's own clock.
   */
  readonly occurredAt: Date;
  readonly now: Date;
  /**
   * The claim key: the entity this claim asserts about, and the folded attribute it asserts.
   * Both are needed for a key, and a claim that declined one carries neither. Everything below
   * is optional, so a write that supplies none of it stores exactly what it stored before a key
   * existed.
   */
  readonly subjectEntityId?: string;
  readonly aspectNorm?: string;
  readonly temporalClass?: TemporalClass;
  /** How long a reading answers for; the horizon is computed from `occurredAt`, never from `now`. */
  readonly readingHorizonDays?: number;
  /** How long an intention stands before the upkeep sweep may close it, on the same clock. */
  readonly intentionHorizonDays?: number;
  /** Whose intention this is. Read on a Goal or a Plan and ignored on every other label. */
  readonly originKind?: IntentionOriginKind;
  /** The date an intention named for its own return. Read on a Goal or a Plan alone. */
  readonly triggerAfter?: Date;
  /** The source episode's content vector, which is an intention's situation trigger. */
  readonly triggerVector?: Vector;
  /** Absent leaves the key inert: it is stored and nothing is closed on it. */
  readonly keyedClose?: KeyedCloseOptions;
};

export type CognitiveNodeWriteResult = {
  readonly node: StampedNodeResult;
  readonly edge: UpsertedEdge;
  /** False when the id already existed: a prior run (or an earlier node in this one) wrote it first. */
  readonly created: boolean;
  /** Absent when no keyed lookup ran, which is different from a lookup that matched nothing. */
  readonly keyedClose?: KeyedCloseResult;
};

/**
 * The node write and its `EXTRACTED_FROM` provenance edge in one transaction, so a crash
 * between the two never leaves a cognitive node with no source. `count: 0` on the edge makes
 * the link itself a total no-op on re-run, matching `supersede()`'s `SUPERSEDES` edge: this
 * is structural provenance, not an observation to tally.
 *
 * A keyed close is the third step of the same transaction. It shares the commit so the claim
 * and the close of what it corrects land together, and so the currency the close reads is the
 * currency the close writes against. A failed close therefore rolls the claim back with it,
 * which is the safe direction: a claim on the graph whose key-mate quietly stayed open answers
 * two ways at once, and a retried episode does not.
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
    ...claimKeyProperties({
      occurredAt: input.occurredAt,
      ...(input.subjectEntityId === undefined ? {} : { subjectEntityId: input.subjectEntityId }),
      ...(input.aspectNorm === undefined ? {} : { aspectNorm: input.aspectNorm }),
      ...(input.temporalClass === undefined ? {} : { temporalClass: input.temporalClass }),
      ...(input.readingHorizonDays === undefined
        ? {}
        : { readingHorizonDays: input.readingHorizonDays }),
    }),
    // After the key block, so an intention's own horizon is the one that lands however the
    // caller classed it. Empty for every label that is not a Goal or a Plan.
    ...intentionProperties({
      label: input.label,
      occurredAt: input.occurredAt,
      ...(input.intentionHorizonDays === undefined
        ? {}
        : { horizonDays: input.intentionHorizonDays }),
      ...(input.originKind === undefined ? {} : { originKind: input.originKind }),
      ...(input.triggerAfter === undefined ? {} : { triggerAfter: input.triggerAfter }),
      ...(input.triggerVector === undefined ? {} : { triggerVector: input.triggerVector }),
    }),
    ...(input.contentVector === undefined
      ? {}
      : {
          [MEMORY_PROPERTIES.contentVector]: toGraphVector(input.contentVector),
          [MEMORY_PROPERTIES.contentVectorHash]: vectorInputHash(input.text),
        }),
  };

  return inWriteTransaction(driver, async (tx) => {
    const node = await writeStampedDerivedNodeInTransaction(tx, {
      label: input.label,
      id,
      now: input.now,
      occurredAt: input.occurredAt,
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

    if (
      input.keyedClose?.mode !== 'close' ||
      input.subjectEntityId === undefined ||
      input.aspectNorm === undefined
    ) {
      return { node, edge, created: node.created };
    }

    const keyedClose = await closeKeyedClaimsInTransaction(tx, {
      newId: id,
      label: input.label,
      episodeId: input.episodeId,
      subjectEntityId: input.subjectEntityId,
      aspectNorm: input.aspectNorm,
      mode: input.keyedClose.mode,
      relatednessFloor: input.keyedClose.relatednessFloor,
      now: input.now,
      // The key-mate stopped being true when the correcting experience happened, which is the
      // episode's own clock and not the moment this write reached the graph.
      validUntil: input.occurredAt,
    });

    return { node, edge, created: node.created, keyedClose };
  });
}
