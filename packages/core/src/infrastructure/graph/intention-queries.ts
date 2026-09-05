import neo4j, { type Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, CLOSURE_PROVENANCE_PROPERTY, closeFragment } from './bitemporal.js';
import type { CognitiveNodeLabel } from './cognitive-queries.js';
import { runRead, runWrite, type GraphStatement } from './connection.js';
import { GraphWriteError } from './errors.js';
import { readModeFragment, VALID_HORIZON_PROPERTY, type ReadMode } from './read-modes.js';
import {
  fromGraphDateTime,
  fromGraphVector,
  toGraphDateTime,
  type GraphProperties,
  type Row,
} from './values.js';
import { CLAIM_SUBJECT_PROPERTY, intentionHorizon } from '../../reflection/domain/claim-key.js';
import type { Vector } from '../providers/types.js';

/**
 * Goals and Plans: what the substrate means to do, as opposed to what it holds true.
 *
 * They are kept apart from `FACT_NODE_LABELS` on purpose. The model-judged supersession stage
 * scans that set for contradictions, and an intention is not a claim about the world that a
 * later claim can contradict: "we plan to move the queue" and "we plan to keep the queue" are
 * two intentions held at two times, not a pair for a judge. What reaches an intention is the
 * deterministic keyed close, where the later statement of the same (subject, aspect) replaces
 * the earlier one with no judgment in it, and the horizon sweep below.
 *
 * The horizon is the other half of the lifecycle. An intention nobody has restated in a long
 * time stopped being what the substrate is doing well before anyone corrects it, so every
 * intention is dated at write from its own episode's clock, down-ranked as expired once that
 * date passes, and closed once it passes by a whole horizon again.
 */

export const INTENTION_NODE_LABELS = [
  'Goal',
  'Plan',
] as const satisfies readonly CognitiveNodeLabel[];

export type IntentionNodeLabel = (typeof INTENTION_NODE_LABELS)[number];

/** Cypher label expression over the intention set: one label scan per label, no store scan. */
const INTENTION_LABEL_EXPRESSION = INTENTION_NODE_LABELS.join('|');

export function isIntentionNodeLabel(value: string): value is IntentionNodeLabel {
  return (INTENTION_NODE_LABELS as readonly string[]).includes(value);
}

/**
 * Whose intention this is. `member` is everything extraction produces from an episode and is
 * never written, following the `is_structural` convention of storing only the departure from
 * the default; `substrate` marks the questions the substrate files for itself.
 */
export const INTENTION_ORIGIN_PROPERTY = 'origin_kind';

export const INTENTION_ORIGIN_KINDS = ['member', 'substrate'] as const;

export type IntentionOriginKind = (typeof INTENTION_ORIGIN_KINDS)[number];

export const DEFAULT_INTENTION_ORIGIN: IntentionOriginKind = 'member';

/**
 * When the intention asks to be brought back, as a date it named itself. Absent on every
 * intention whose text named no moment, which is most of them.
 */
export const TRIGGER_AFTER_PROPERTY = 'trigger_after';

/**
 * The situation the intention was formed in: the content vector of the episode it came from,
 * stored on every intention. It is a second vector rather than the node's own `content_vec`
 * because the two answer different questions. `content_vec` is the intention's sentence, which
 * is what a query matches against; this is the surrounding conversation, which is what says
 * whether a later moment resembles the one that produced it.
 */
export const TRIGGER_VECTOR_PROPERTY = 'trigger_vec';

export type IntentionPropertiesInput = {
  readonly label: CognitiveNodeLabel;
  /** The world time of the experience the intention came from, which the horizon counts from. */
  readonly occurredAt: Date;
  readonly horizonDays?: number;
  readonly originKind?: IntentionOriginKind;
  /** The moment the intention named for its own return, when its text named one. */
  readonly triggerAfter?: Date;
  /** The source episode's content vector. Absent when that episode's vector is still pending. */
  readonly triggerVector?: Vector;
};

/**
 * An intention's own half of the property block, empty for every other label. The horizon is
 * computed here, from the episode's clock, so a replayed episode gets the horizon its
 * experience earned rather than one dated to the replay.
 */
export function intentionProperties(input: IntentionPropertiesInput): GraphProperties {
  if (!isIntentionNodeLabel(input.label)) {
    return {};
  }
  const origin = input.originKind ?? DEFAULT_INTENTION_ORIGIN;
  return {
    [VALID_HORIZON_PROPERTY]:
      input.horizonDays === undefined
        ? undefined
        : intentionHorizon(input.occurredAt, input.horizonDays),
    [INTENTION_ORIGIN_PROPERTY]: origin === DEFAULT_INTENTION_ORIGIN ? undefined : origin,
    [TRIGGER_AFTER_PROPERTY]: input.triggerAfter,
    [TRIGGER_VECTOR_PROPERTY]: input.triggerVector,
  };
}

/** The value `CLOSURE_PROVENANCE_PROPERTY` carries, naming this operation as the closer. */
export const CLOSED_BY_INTENTION_UPKEEP = 'intention_upkeep';

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GraphWriteError(`${name} must be a positive integer, received ${value}`);
  }
}

/**
 * How many open intentions one recall reads. The match that follows is three comparisons per
 * row and costs nothing; the read is what needs a bound, because each row carries a stored
 * vector and a substrate that accumulated thousands of open intentions would put all of them on
 * a hot path that is allowed one generation call and no surprises.
 *
 * Newest first. An intention nobody has restated in months is the one the horizon sweep is
 * already closing, so it is the right one to fall off the end of a full scan.
 */
export const TRIGGERABLE_INTENTION_SCAN_LIMIT = 100;

/** An open intention as the trigger match reads it: an id and whatever conditions it carries. */
export type TriggerableIntention = {
  readonly id: string;
  /** The entity the intention is about, which is the entity trigger. */
  readonly subjectEntityId?: string;
  readonly triggerAfter?: Date;
  readonly triggerVector?: Vector;
};

export type TriggerableIntentionsInput = {
  readonly mode: ReadMode;
  /** The recall's clock. An intention past its horizon is down-ranked, so it never triggers. */
  readonly now: Date;
  readonly limit: number;
};

/**
 * Open intentions carrying at least one condition for their own return: still current on both
 * timelines, not yet expired, and naming a subject, a date, or a situation.
 *
 * Expired is excluded rather than down-ranked here. Everywhere else the read mode annotates an
 * aged-out row and lets the reader judge it, but a trigger is the substrate volunteering
 * something nobody asked for, and volunteering a plan whose own horizon has passed is the one
 * case where the annotation arrives too late to help.
 */
export function buildTriggerableIntentionsStatement(
  input: TriggerableIntentionsInput,
): GraphStatement {
  assertPositiveInt('limit', input.limit);
  const fragment = readModeFragment(input.mode, 'n');
  const cypher = [
    `MATCH (n:${INTENTION_LABEL_EXPRESSION})`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `  AND ${fragment.where}`,
    `  AND (n.${VALID_HORIZON_PROPERTY} IS NULL OR n.${VALID_HORIZON_PROPERTY} > $now)`,
    `  AND (n.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL`,
    `    OR n.${TRIGGER_AFTER_PROPERTY} IS NOT NULL`,
    `    OR n.${TRIGGER_VECTOR_PROPERTY} IS NOT NULL)`,
    'RETURN',
    '  n.id AS id,',
    `  n.${CLAIM_SUBJECT_PROPERTY} AS subject_entity_id,`,
    `  n.${TRIGGER_AFTER_PROPERTY} AS trigger_after,`,
    `  n.${TRIGGER_VECTOR_PROPERTY} AS trigger_vec`,
    `ORDER BY n.${BITEMPORAL_PROPERTIES.occurredAt} DESC, n.id`,
    'LIMIT $limit',
  ].join('\n');
  return {
    cypher,
    parameters: {
      ...fragment.parameters,
      now: toGraphDateTime(input.now),
      limit: neo4j.int(input.limit),
    },
  };
}

function mapTriggerableIntention(row: Row): TriggerableIntention {
  const subjectEntityId = row.subject_entity_id;
  const triggerAfter = fromGraphDateTime(row.trigger_after);
  const triggerVector = fromGraphVector(row.trigger_vec);
  return {
    id: row.id as string,
    ...(typeof subjectEntityId === 'string' ? { subjectEntityId } : {}),
    ...(triggerAfter === undefined ? {} : { triggerAfter }),
    ...(triggerVector === undefined ? {} : { triggerVector }),
  };
}

export async function findTriggerableIntentions(
  driver: Driver,
  input: TriggerableIntentionsInput,
): Promise<TriggerableIntention[]> {
  const statement = buildTriggerableIntentionsStatement(input);
  return runRead(driver, statement.cypher, statement.parameters, mapTriggerableIntention);
}

/**
 * Open intentions whose horizon passed before `staleBefore`. The caller sets that mark a whole
 * horizon behind the clock, so an intention that is merely expired is left alone: the read side
 * already down-ranks it and says so, and a plan a month past its date is still what the last
 * conversation about it said.
 *
 * Oldest horizon first, so a long backlog drains in the order the intentions went stale rather
 * than in id order, which carries no age.
 */
export function buildStaleIntentionsStatement(staleBefore: Date, limit: number): GraphStatement {
  assertPositiveInt('limit', limit);
  const cypher = [
    `MATCH (n:${INTENTION_LABEL_EXPRESSION})`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    `  AND n.${VALID_HORIZON_PROPERTY} IS NOT NULL`,
    `  AND n.${VALID_HORIZON_PROPERTY} <= $staleBefore`,
    `RETURN n.id AS id, n.${VALID_HORIZON_PROPERTY} AS valid_horizon`,
    `ORDER BY n.${VALID_HORIZON_PROPERTY}, n.id`,
    'LIMIT $limit',
  ].join('\n');
  return {
    cypher,
    parameters: { staleBefore: toGraphDateTime(staleBefore), limit: neo4j.int(limit) },
  };
}

/** The id and the date it went stale. No text: what an upkeep run records must carry none. */
export type StaleIntention = {
  readonly id: string;
  readonly validHorizon: Date;
};

function mapStaleIntention(row: Row): StaleIntention {
  return { id: row.id as string, validHorizon: row.valid_horizon as Date };
}

export async function findStaleIntentions(
  driver: Driver,
  staleBefore: Date,
  limit: number,
): Promise<StaleIntention[]> {
  const statement = buildStaleIntentionsStatement(staleBefore, limit);
  return runRead(driver, statement.cypher, statement.parameters, mapStaleIntention);
}

/**
 * Closes each named intention on both timelines and stamps which operation did it.
 *
 * `forgotten_at` is deliberately untouched. A forget is a person's act and `aion unsupersede`
 * does not undo one, so an upkeep close that wrote it would be a close the documented undo
 * cannot reverse.
 *
 * The staleness test runs again inside the write. The scan that chose the ids ran first, and an
 * intention restated in between carries a fresh horizon that the close must not take.
 * `closeFragment`'s own `coalesce` makes a repeated close a no-op rather than a timestamp bump.
 */
export function buildCloseStaleIntentionsStatement(
  ids: readonly string[],
  now: Date,
  staleBefore: Date,
): GraphStatement {
  if (ids.length === 0) {
    throw new GraphWriteError('intention upkeep needs at least one intention id to close');
  }
  const cypher = [
    'UNWIND $ids AS id',
    `MATCH (n:${INTENTION_LABEL_EXPRESSION} { id: id })`,
    `WHERE n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
    `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
    `  AND n.${VALID_HORIZON_PROPERTY} IS NOT NULL`,
    `  AND n.${VALID_HORIZON_PROPERTY} <= $staleBefore`,
    `SET n.${CLOSURE_PROVENANCE_PROPERTY} = coalesce(n.${CLOSURE_PROVENANCE_PROPERTY}, $closedBy),`,
    `    ${closeFragment('n')}`,
    'RETURN n.id AS id',
    'ORDER BY id',
  ].join('\n');
  return {
    cypher,
    parameters: {
      ids: [...ids],
      staleBefore: toGraphDateTime(staleBefore),
      // The close is the substrate deciding at the sweep that nobody came back to this, so both
      // timelines end there rather than at the horizon the intention was written with.
      validUntil: toGraphDateTime(now),
      txUntil: toGraphDateTime(now),
      closedBy: CLOSED_BY_INTENTION_UPKEEP,
    },
  };
}

export async function closeStaleIntentions(
  driver: Driver,
  ids: readonly string[],
  now: Date,
  staleBefore: Date,
): Promise<string[]> {
  const statement = buildCloseStaleIntentionsStatement(ids, now, staleBefore);
  return runWrite(driver, statement.cypher, statement.parameters, (row) => row.id as string);
}
