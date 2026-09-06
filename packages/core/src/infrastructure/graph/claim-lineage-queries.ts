import type { Driver } from 'neo4j-driver';

import { edgeVisibility } from './adjacency.js';
import { runRead, type GraphStatement } from './connection.js';
import { BASE_NODE_LABEL } from './labels.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import type { Row } from './values.js';

/**
 * How far back a memory's sources go.
 *
 * A capture states where it came from, and what it named may state a source of its own.
 * Following one hop and calling the answer a root is what lets two descendants of one origin
 * report two different sources and read as two witnesses, so the walk follows the chain until
 * every branch reaches a capture that names nothing further.
 */

/** The stated-source edge: `(Episode)-[:DERIVES_FROM]->(what it came from)`. */
export const STATED_SOURCE_TYPE: RelationshipType = 'DERIVES_FROM';

/**
 * How many stated references the substrate could not resolve, kept on the episode they were
 * stated about. A descendant reads it and says its lineage is short, which is the alternative
 * to reporting fewer roots as though that were the whole set.
 */
export const UNRESOLVED_REFERENCES_PROPERTY = 'provenance_unresolved';

export type CaptureSources = {
  readonly sources: readonly string[];
  readonly unresolved: number;
};

/**
 * What each capture was stated to have come from, one hop. The walk above it follows the chain;
 * a capture with no stated source is where the chain ends and stands as its own root, which is
 * what makes two turns of one episode read as one witness.
 *
 * The stated-source edge carries the read mode for the same reason the evidence edges do: a
 * source stated on Friday about an episode written on Monday is not lineage a Tuesday read held.
 */
function sourceStatement(captureIds: readonly string[], mode: ReadMode): GraphStatement {
  const capture = readModeFragment(mode, 'c');
  const root = readModeFragment(mode, 'root', 'rmroot');
  const sourceEdge = edgeVisibility(mode, 'sr', 'rmroot');
  const cypher = [
    'UNWIND $ids AS wantedId',
    'MATCH (c:Episode { id: wantedId })',
    `WHERE ${capture.where}`,
    `OPTIONAL MATCH (c)-[sr:${STATED_SOURCE_TYPE}]->(root:${BASE_NODE_LABEL})`,
    `WHERE ${root.where} AND ${sourceEdge}`,
    'WITH c, root',
    'ORDER BY root.id',
    'RETURN c.id AS id,',
    '       collect(DISTINCT root.id) AS sources,',
    `       coalesce(c.${UNRESOLVED_REFERENCES_PROPERTY}, 0) AS unresolved`,
  ].join('\n');
  return {
    cypher,
    parameters: { ...capture.parameters, ...root.parameters, ids: [...new Set(captureIds)] },
  };
}

/**
 * How far the walk follows stated sources before it stops and says so. A chain longer than this
 * is reported short rather than followed forever: the reference list is caller-supplied, so the
 * bound is what keeps a cycle or a deep import from turning one recall into an unbounded number
 * of reads.
 */
export const MAX_LINEAGE_HOPS = 4;

type Ancestry = {
  readonly roots: readonly string[];
  readonly lineage: readonly string[];
  readonly complete: boolean;
};

/**
 * The chain behind each capture, followed until every branch reaches a capture that states no
 * source of its own. One hop is not enough: an episode stated to come from another episode that
 * itself names the shared root would otherwise report the middle link, and two descendants of
 * one root would report two different sources and read as two witnesses.
 *
 * `lineage` keeps every id the walk touched, the starting captures included, because that is
 * the set an overlap test needs. `roots` keeps only where the chain ended, which is what a
 * reader is shown.
 */
export function foldAncestry(
  captures: readonly string[],
  sources: ReadonlyMap<string, CaptureSources>,
  maxRoots: number,
): Ancestry {
  const roots = new Set<string>();
  const lineage = new Set<string>(captures);
  let unresolved = 0;
  let frontier: readonly string[] = captures;

  for (let hop = 0; hop <= MAX_LINEAGE_HOPS && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      const source = sources.get(id);
      if (source === undefined) {
        roots.add(id);
        continue;
      }
      // Counted before the branch: a capture that named a source the substrate could not place
      // has no edge to follow, so its whole reference list would otherwise go unreported.
      unresolved += source.unresolved;
      if (source.sources.length === 0) {
        roots.add(id);
        continue;
      }
      for (const parent of source.sources) {
        if (lineage.has(parent)) {
          continue;
        }
        lineage.add(parent);
        next.push(parent);
      }
    }
    if (hop === MAX_LINEAGE_HOPS && next.length > 0) {
      // The chain runs past the bound. Whatever the walk had reached stands as the answer, and
      // the incomplete flag is what stops it reading as the whole ancestry.
      for (const id of next) {
        roots.add(id);
      }
      return {
        roots: [...roots].sort().slice(0, maxRoots),
        lineage: [...lineage],
        complete: false,
      };
    }
    frontier = next;
  }

  const ordered = [...roots].sort();
  return {
    roots: ordered.slice(0, maxRoots),
    lineage: [...lineage],
    complete: ordered.length <= maxRoots && unresolved === 0,
  };
}

/**
 * Every capture the walk still has to ask about, in rounds: the starting captures, then
 * whatever they named, until nothing new comes back or the hop bound stops it. Each round is
 * one batched read, so a chain costs hops rather than nodes.
 */
export async function readAncestry(
  driver: Driver,
  captureIds: ReadonlySet<string>,
  mode: ReadMode,
): Promise<ReadonlyMap<string, CaptureSources>> {
  const sources = new Map<string, CaptureSources>();
  let frontier = [...captureIds];

  for (let hop = 0; hop <= MAX_LINEAGE_HOPS && frontier.length > 0; hop += 1) {
    const rows = await runRead(driver, sourceStatement(frontier, mode), (row: Row) => ({
      id: row.id as string,
      sources: ((row.sources as string[] | null) ?? []).filter((id) => id.length > 0),
      unresolved: (row.unresolved as number | null) ?? 0,
    }));
    const next: string[] = [];
    for (const row of rows) {
      sources.set(row.id, { sources: row.sources, unresolved: row.unresolved });
      for (const parent of row.sources) {
        if (!sources.has(parent)) {
          next.push(parent);
        }
      }
    }
    frontier = [...new Set(next)];
  }
  return sources;
}
