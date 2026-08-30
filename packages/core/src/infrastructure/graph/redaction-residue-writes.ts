import type { Driver } from 'neo4j-driver';

import { runRead, runWrite } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * The residue purge's two graph reads and writes. `readStoredText` (`introspection.ts`)
 * answers "which nodes leak", concatenated across every string property for the entropy
 * scan; this module answers "what does the leaking node's own property map look like",
 * which the purge needs to rewrite the one property that actually leaked and leave the rest
 * of the node untouched.
 *
 * `id` is excluded from every read and write here on purpose, in Cypher and again in the
 * caller. Redaction is a text classifier; a false positive on any other property costs a
 * fingerprint, but a false positive on `id` breaks the node's own identity, silently
 * detaching every relationship an id-keyed match would otherwise find.
 */

export type NodeStringProperties = {
  readonly id: string;
  readonly properties: Readonly<Record<string, string>>;
};

const READ_NODE_STRING_PROPERTIES = [
  'UNWIND $ids AS nodeId',
  `MATCH (n:${BASE_NODE_LABEL} { id: nodeId })`,
  "WITH n, [k IN keys(n) WHERE n[k] IS :: STRING AND k <> 'id'] AS stringKeys",
  'RETURN n.id AS id, stringKeys AS keys, [k IN stringKeys | n[k]] AS values',
].join('\n');

function toProperties(row: Row): NodeStringProperties {
  const keys = row.keys as string[];
  const values = row.values as string[];
  const properties: Record<string, string> = {};
  keys.forEach((key, index) => {
    const value = values[index];
    if (value !== undefined) {
      properties[key] = value;
    }
  });
  return { id: row.id as string, properties };
}

export async function readNodeStringProperties(
  driver: Driver,
  ids: readonly string[],
): Promise<NodeStringProperties[]> {
  if (ids.length === 0) {
    return [];
  }
  return runRead(driver, READ_NODE_STRING_PROPERTIES, { ids: [...ids] }, toProperties);
}

export type RedactedPropertyUpdate = {
  readonly id: string;
  /** Only the properties whose text changed; `id` is never a key here. */
  readonly properties: Readonly<Record<string, string>>;
};

const WRITE_REDACTED_PROPERTIES = [
  'UNWIND $updates AS update',
  `MATCH (n:${BASE_NODE_LABEL} { id: update.id })`,
  'SET n += update.properties, n.redacted_at = $now',
  'RETURN n.id AS id',
].join('\n');

/** The ids actually rewritten, which is what the caller counts as `itemsAffected`. */
export async function writeRedactedProperties(
  driver: Driver,
  updates: readonly RedactedPropertyUpdate[],
  now: Date,
): Promise<string[]> {
  const safe = updates
    .map((update) => ({
      id: update.id,
      properties: Object.fromEntries(
        Object.entries(update.properties).filter(([key]) => key !== 'id'),
      ),
    }))
    .filter((update) => Object.keys(update.properties).length > 0);
  if (safe.length === 0) {
    return [];
  }
  return runWrite(
    driver,
    WRITE_REDACTED_PROPERTIES,
    { updates: safe, now: toGraphDateTime(now) },
    (row) => row.id as string,
  );
}
