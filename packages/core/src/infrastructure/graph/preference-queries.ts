import type { Driver } from 'neo4j-driver';
import { createHash } from 'node:crypto';

import {
  BITEMPORAL_PROPERTIES,
  currentOnly,
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from './bitemporal.js';
import { normalizeCognitiveText } from './cognitive-text.js';
import { inWriteTransaction, runRead } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { DERIVES_FROM_TYPE } from './narrative-queries.js';
import { toGraphInteger, toGraphVector } from './values.js';
import { vectorInputHash } from '../../reflection/domain/vector-input.js';
import type { Vector } from '../providers/types.js';

/**
 * Preferences, in the graph: what is already held, and the write that stores or revises one.
 *
 * A `Preference` node says how somebody likes to work, read off how they worked. It is never a
 * sentence anybody said, so the node carries three things a reader needs in order not to mistake
 * it for one: the flag that says it is inferred, the recorded roles of the lines it was read off,
 * and its grounds as `DERIVES_FROM` edges to those lines. Serving renders the first of those as
 * the item's standing, and `aion why` walks the third.
 */

export const PREFERENCE_LABEL = 'Preference';

export const PREFERENCE_PROVENANCE = 'reflection';
export const PREFERENCE_SIGNAL = 'preference_inference';

/** Always true, and written rather than assumed. Nothing states a preference in these words. */
export const PREFERENCE_INFERRED_PROPERTY = 'inferred';
/** `standing` or `contextual`. A contextual preference also carries the situation it holds in. */
export const PREFERENCE_SCOPE_PROPERTY = 'scope';
export const PREFERENCE_CONTEXT_PROPERTY = 'context';
/**
 * The roles capture recorded on the lines this was read off, verbatim and deduplicated.
 *
 * A role says something was said and never who said it: agent-to-agent traffic arrives under
 * `user` like everything else. It is stored so a reader can weigh the preference rather than so
 * anything can branch on it, and nothing here turns a role into an attribution.
 */
export const PREFERENCE_ROLES_PROPERTY = 'signal_roles';
export const PREFERENCE_CONFIDENCE_PROPERTY = 'confidence';
/** Distinct lines this preference has ever been read off, which is what repetition means here. */
export const PREFERENCE_OBSERVATIONS_PROPERTY = 'observations';

/**
 * Node identity: the member, the normalized preference text, and the condition it holds under.
 *
 * Not the grounds. A preference the substrate reads twice off two different days is one
 * preference observed twice, and folding the grounds in would mint a second node for it. The
 * observation count on the node is what carries the repetition.
 *
 * The condition is folded in because two conditions are two preferences. "A concise summary" for
 * code review and the same words for an incident handoff are different things to hold, and a key
 * over the wording alone MERGEs them into one node whose condition is whichever was written
 * last. Whether one of them should broaden into the other is a reading of what somebody meant,
 * which the model makes; storage must not make it by text collision. An unconditional preference
 * folds exactly as it did before, so nothing already held moves.
 *
 * The parts join on a NUL escape, which no id can contain. Written as `\u0000` rather than as
 * the byte: a literal NUL makes git read the file as binary.
 */
export function derivePreferenceId(memberId: string, textNorm: string, context?: string): string {
  const held = context === undefined ? [] : [normalizeCognitiveText(context)];
  return createHash('sha256')
    .update([memberId, textNorm, ...held].join('\u0000'))
    .digest('hex');
}

export type StandingPreferenceRow = {
  readonly id: string;
  readonly text: string;
  readonly revision: number;
  readonly scope: string;
  /**
   * The situation a contextual preference holds in, absent on an unconditional one. It travels
   * with the text because the two are one statement: "does not require approval" read back
   * without "for local throwaway test stores only" is a different preference.
   */
  readonly context?: string;
  readonly groundIds: readonly string[];
};

const LIFECYCLE = `coalesce(n.${BITEMPORAL_PROPERTIES.lifecycleRevision}, 1)`;

const STANDING_PREFERENCES = [
  `MATCH (n:${PREFERENCE_LABEL})-[:${DERIVES_FROM_TYPE}]->(:Turn)`,
  `WHERE ${currentOnly('n')}`,
  'WITH DISTINCT n',
  `OPTIONAL MATCH (n)-[:${DERIVES_FROM_TYPE}]->(g)`,
  `RETURN n.id AS id, n.${MEMORY_PROPERTIES.text} AS text, ${LIFECYCLE} AS revision,`,
  `       n.${PREFERENCE_SCOPE_PROPERTY} AS scope, n.${PREFERENCE_CONTEXT_PROPERTY} AS context,`,
  '       [groundId IN collect(DISTINCT g.id) WHERE groundId IS NOT NULL] AS ground_ids',
  'ORDER BY id',
  'LIMIT $limit',
].join('\n');

/**
 * Every preference the substrate currently holds, with the lines each was read off.
 *
 * The population is small by construction (`recall.maxPreferences` serves three of them) and
 * bounded here anyway, because what bounds a model's input is the pass and not the reader.
 */
export async function findStandingPreferences(
  driver: Driver,
  limit: number,
): Promise<StandingPreferenceRow[]> {
  return runRead(driver, STANDING_PREFERENCES, { limit: toGraphInteger(limit) }, (row) => ({
    id: row.id as string,
    text: (row.text as string | null) ?? '',
    revision: Number(row.revision ?? 1),
    scope: (row.scope as string | null) ?? 'standing',
    ...(typeof row.context === 'string' ? { context: row.context } : {}),
    groundIds: (row.ground_ids as string[] | null) ?? [],
  }));
}

export type PreferenceWrite = {
  readonly memberId: string;
  readonly text: string;
  readonly textNorm: string;
  readonly groundIds: readonly string[];
  readonly roles: readonly string[];
  readonly scope: string;
  readonly context?: string;
  readonly confidence: number;
  readonly contentVector?: Vector;
  /** The preference this one revises. Its predecessor is closed and stays reachable. */
  readonly replacesId?: string;
  readonly occurredAt: Date;
  readonly now: Date;
};

export type PreferenceWriteResult = {
  readonly id: string;
  readonly created: boolean;
  readonly observations: number;
  readonly replacedId?: string;
};

/**
 * The node, its grounds and its revision, in one transaction.
 *
 * The observation count moves on distinct grounds rather than on calls. A `DERIVES_FROM` edge
 * carries `count: 0` and MERGEs on its endpoints, so reading the same preference off the same
 * line twice changes nothing, and reading it off a new line is what counts as seeing it again.
 * That is the whole guard against the substrate confirming itself: an echo the pass let through
 * would have to be a line nothing has read before, and a repeat of one it has read is inert.
 */
export async function writePreference(
  driver: Driver,
  input: PreferenceWrite,
): Promise<PreferenceWriteResult> {
  const id = derivePreferenceId(input.memberId, input.textNorm, input.context);
  return inWriteTransaction(driver, async (tx) => {
    const node = await writeStampedDerivedNodeInTransaction(tx, {
      label: PREFERENCE_LABEL,
      id,
      occurredAt: input.occurredAt,
      now: input.now,
      properties: {
        [MEMORY_PROPERTIES.text]: input.text,
        ...(input.contentVector === undefined
          ? {}
          : {
              [MEMORY_PROPERTIES.contentVector]: toGraphVector(input.contentVector),
              [MEMORY_PROPERTIES.contentVectorHash]: vectorInputHash(input.text),
            }),
        [PREFERENCE_INFERRED_PROPERTY]: true,
        [PREFERENCE_SCOPE_PROPERTY]: input.scope,
        ...(input.context === undefined ? {} : { [PREFERENCE_CONTEXT_PROPERTY]: input.context }),
        [PREFERENCE_ROLES_PROPERTY]: [...input.roles],
        [PREFERENCE_CONFIDENCE_PROPERTY]: input.confidence,
      },
      // Applied on match too: a later pass reading the same preference off another line adds
      // that line's role to the set, and the confidence is the latest reading rather than the
      // first. Neither is derived from the clock, so neither rewrites the node's stamp. The
      // condition is not here: it is part of the identity above, so a match is already a match
      // on it, and writing it again could only ever restate what the node says.
      mergeProperties: {
        [PREFERENCE_CONFIDENCE_PROPERTY]: input.confidence,
      },
    });

    for (const groundId of [...new Set(input.groundIds)].sort()) {
      await upsertEdgeInTransaction(tx, {
        type: DERIVES_FROM_TYPE,
        sourceId: node.id,
        targetId: groundId,
        strength: input.confidence,
        confidence: input.confidence,
        signals: [PREFERENCE_SIGNAL],
        provenance: [PREFERENCE_PROVENANCE],
        count: 0,
        rationale: 'the preference was read off this line',
        now: input.now,
      });
    }

    const counted = await tx.run(
      [
        `MATCH (n:${PREFERENCE_LABEL} { id: $id })-[r:${DERIVES_FROM_TYPE}]->()`,
        `WHERE r.${BITEMPORAL_PROPERTIES.validUntil} IS NULL`,
        'WITH n, count(r) AS observations',
        `SET n.${PREFERENCE_ROLES_PROPERTY} =`,
        `      coalesce(n.${PREFERENCE_ROLES_PROPERTY}, []) +`,
        `      [role IN $roles WHERE NOT role IN coalesce(n.${PREFERENCE_ROLES_PROPERTY}, [])],`,
        `    n.${PREFERENCE_OBSERVATIONS_PROPERTY} = observations`,
        'RETURN observations',
      ].join('\n'),
      { id: node.id, roles: [...input.roles] },
      (row) => Number(row.observations ?? 0),
    );
    const observations = counted[0] ?? 0;

    if (input.replacesId === undefined) {
      return { id: node.id, created: node.created, observations };
    }
    await supersedeInTransaction(tx, {
      oldId: input.replacesId,
      newId: node.id,
      signals: [PREFERENCE_SIGNAL],
      provenance: [PREFERENCE_PROVENANCE],
      now: input.now,
    });
    return { id: node.id, created: node.created, observations, replacedId: input.replacesId };
  });
}

export type StoredPreference = {
  readonly id: string;
  readonly text: string;
  readonly inferred: boolean;
  readonly scope: string;
  readonly context?: string;
  readonly roles: readonly string[];
  readonly observations: number;
  readonly closedAt?: Date;
};

const READ_PREFERENCE = [
  `MATCH (n:${PREFERENCE_LABEL} { id: $id })`,
  `RETURN n.id AS id, n.${MEMORY_PROPERTIES.text} AS text,`,
  `       n.${PREFERENCE_INFERRED_PROPERTY} AS inferred, n.${PREFERENCE_SCOPE_PROPERTY} AS scope,`,
  `       n.${PREFERENCE_CONTEXT_PROPERTY} AS context, n.${PREFERENCE_ROLES_PROPERTY} AS roles,`,
  `       n.${PREFERENCE_OBSERVATIONS_PROPERTY} AS observations,`,
  `       n.${BITEMPORAL_PROPERTIES.validUntil} AS closed_at`,
].join('\n');

export async function readPreference(
  driver: Driver,
  id: string,
): Promise<StoredPreference | undefined> {
  const rows = await runRead(driver, READ_PREFERENCE, { id }, (row) => ({
    id: row.id as string,
    text: (row.text as string | null) ?? '',
    inferred: row.inferred === true,
    scope: (row.scope as string | null) ?? 'standing',
    ...(typeof row.context === 'string' ? { context: row.context } : {}),
    roles: (row.roles as string[] | null) ?? [],
    observations: Number(row.observations ?? 0),
    ...(row.closed_at === null || row.closed_at === undefined
      ? {}
      : { closedAt: row.closed_at as Date }),
  }));
  return rows[0];
}
