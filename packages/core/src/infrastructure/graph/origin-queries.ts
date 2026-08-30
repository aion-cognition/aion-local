import type { Driver } from 'neo4j-driver';

import { runRead } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, ENTITY_LABEL, EXTRACTION_TYPE } from './labels.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import type { Row } from './values.js';

/**
 * Which sessions produced a memory, for the one caller that has to tell a session its own
 * record apart from everything else the substrate holds. Provenance reaches a node three
 * different ways, and the answer is the union of all three:
 *
 * a Turn, an Episode and a session Narrative carry `session_id` on the node; the nine
 * cognitive types carry none and hang off `EXTRACTED_FROM` to the episode they were extracted
 * from; an Entity hangs off neither, because one entity outlives every episode that named it
 * and its description accretes from all of them, so its provenance is the set of episodes that
 * `MENTIONS` it rather than any single source.
 *
 * The entity leg is two existence checks rather than a collect, so a name a thousand episodes
 * mention stops at the first episode that answers instead of materializing a thousand session
 * ids for a question with a yes or no answer.
 */

export type ItemOrigin = {
  /** The asking session is among the sessions the item's provenance names. */
  readonly own: boolean;
  /** So is some other session, which is what makes the item more than the asker's own record. */
  readonly other: boolean;
};

export type ItemOriginInput = {
  readonly ids: readonly string[];
  /** The asking session. Every verdict is relative to it, so nothing here is cacheable across sessions. */
  readonly sessionId: string;
  readonly mode: ReadMode;
};

const SESSION_PROPERTY = MEMORY_PROPERTIES.sessionId;

/** A mention from an episode this session did not write, which is what makes an entity shared. */
function mentionedBy(predicate: string): string {
  return (
    `(n:${ENTITY_LABEL} AND EXISTS { MATCH (m:Episode)-[:${ENTITY_MENTION_TYPE}]->(n)` +
    ` WHERE ${predicate} })`
  );
}

/**
 * An episode carrying no `session_id` is provenance nothing can attribute, so it counts as
 * another session's: serving a memory twice costs tokens, and withholding one the asker never
 * saw costs the answer.
 */
function statement(input: ItemOriginInput): {
  cypher: string;
  parameters: Record<string, unknown>;
} {
  const fragment = readModeFragment(input.mode, 'n');
  const extracted = `[ (n)-[:${EXTRACTION_TYPE}]->(src:Episode) | src.${SESSION_PROPERTY} ]`;
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (n:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${fragment.where}`,
    `WITH n, ${extracted} AS sources`,
    'RETURN n.id AS id,',
    `       ((n.${SESSION_PROPERTY} IS NOT NULL AND n.${SESSION_PROPERTY} = $sessionId)`,
    '        OR any(s IN sources WHERE s IS NOT NULL AND s = $sessionId)',
    `        OR ${mentionedBy(`m.${SESSION_PROPERTY} = $sessionId`)}) AS own,`,
    `       ((n.${SESSION_PROPERTY} IS NOT NULL AND n.${SESSION_PROPERTY} <> $sessionId)`,
    '        OR any(s IN sources WHERE s IS NULL OR s <> $sessionId)',
    `        OR ${mentionedBy(`m.${SESSION_PROPERTY} IS NULL OR m.${SESSION_PROPERTY} <> $sessionId`)}) AS other`,
  ].join('\n');

  return {
    cypher,
    parameters: {
      ...fragment.parameters,
      ids: [...new Set(input.ids)],
      sessionId: input.sessionId,
    },
  };
}

function mapOrigin(row: Row): { id: string; origin: ItemOrigin } {
  return {
    id: row.id as string,
    origin: { own: row.own === true, other: row.other === true },
  };
}

/**
 * Batched, like every other read recall makes against ids it already holds. An id missing from
 * the answer carries no verdict at all, which is what a caller has to treat as unknown rather
 * than as either answer.
 */
export async function fetchItemOrigins(
  driver: Driver,
  input: ItemOriginInput,
): Promise<ReadonlyMap<string, ItemOrigin>> {
  if (input.ids.length === 0) {
    return new Map();
  }
  const rows = await runRead(driver, statement(input), mapOrigin);
  return new Map(rows.map((row) => [row.id, row.origin]));
}
