import type { Driver } from 'neo4j-driver';

import { edgeVisibility } from './adjacency.js';
import { runRead, type GraphStatement } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE } from './labels.js';
import { NARRATIVE_LABEL, NARRATIVE_PROPERTIES } from './narrative-queries.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import type { RelationshipType } from './relationships.js';
import type { Row } from './values.js';

/**
 * How far back a memory's sources go.
 *
 * A capture states where it came from, and what it named may state a source of its own.
 * Following one hop and calling the answer a root is what lets two descendants of one origin
 * report two different sources and read as two witnesses, so the walk follows the chain until
 * every branch reaches a node that names nothing further.
 *
 * A stated source may be any node, not only an episode. A caller pointing at an extracted claim
 * is pointing through it at the capture that claim came out of, so the step below answers for
 * every node type: an episode hands back what it was stated to derive from, and anything else
 * hands back the capture it belongs to.
 */

/** The stated-source edge: `(Episode)-[:DERIVES_FROM]->(what it came from)`. */
export const STATED_SOURCE_TYPE: RelationshipType = 'DERIVES_FROM';

/**
 * How many stated references the substrate could not resolve, kept on the episode they were
 * stated about. A descendant reads it and says its lineage is short, which is the alternative
 * to reporting fewer roots as though that were the whole set.
 */
export const UNRESOLVED_REFERENCES_PROPERTY = 'provenance_unresolved';

export type NodeParents = {
  /** One step further back. Empty means the chain ends here and this node is a root. */
  readonly parents: readonly string[];
  readonly unresolved: number;
  /**
   * Set when the node's own sources cannot be established: a narrative that cites nothing, and
   * one whose citations name something no reader at this vantage can reach. Neither is a chain
   * that ended, and reporting either as a terminal root would invent a source.
   */
  readonly unknownSource?: boolean;
};

/**
 * One step back from any node.
 *
 * A narrative wins first, and it answers with the ids its stored sentences cited. It names no
 * capture and hangs off no extraction edge, so without this it looks like a node that came from
 * nowhere. Its `DERIVES_FROM` edge is deliberately passed over: that points at the session the
 * narrative compresses, which says where it lives rather than what it was drawn from, and reading
 * it as ancestry would make every narrative of a session one witness with every other.
 *
 * A stated source wins next, when the node has one: that is somebody saying outright where this
 * came from. Otherwise the step is the node's own capture, which is how a claim stated as a source
 * hands the walk the episode it was extracted from instead of ending the chain at itself. A
 * capture that is its own only parent is where the chain ends, and that is what makes two turns
 * of one episode read as one witness.
 *
 * Citations are resolved here rather than only at the first read, because a narrative is reached
 * mid-walk too: a rollup cites member narratives, and an episode can state a narrative as its
 * source. Every arm carries the read mode for the same reason the evidence edges do: a source
 * stated on Friday about an episode written on Monday is not lineage a Tuesday read held.
 */
function parentStatement(ids: readonly string[], mode: ReadMode): GraphStatement {
  const node = readModeFragment(mode, 'c');
  const root = readModeFragment(mode, 'root', 'rmroot');
  const own = readModeFragment(mode, 'own', 'rmown');
  const extracted = readModeFragment(mode, 'ex', 'rmex');
  const cited = readModeFragment(mode, 'cited', 'rmcited');
  const sourceEdge = edgeVisibility(mode, 'sr', 'rmroot');
  const cypher = [
    'UNWIND $ids AS wantedId',
    `MATCH (c:${BASE_NODE_LABEL} { id: wantedId })`,
    `WHERE ${node.where}`,
    `OPTIONAL MATCH (c)-[sr:${STATED_SOURCE_TYPE}]->(root:${BASE_NODE_LABEL})`,
    `WHERE ${root.where} AND ${sourceEdge}`,
    'WITH c, root',
    'ORDER BY root.id',
    'WITH c, collect(DISTINCT root.id) AS stated',
    'OPTIONAL MATCH (own:Episode)',
    `WHERE own.id = c.${MEMORY_PROPERTIES.sourceEpisodeId} AND ${own.where}`,
    'WITH c, stated, collect(DISTINCT own.id) AS ownIds',
    `WITH c, stated, ownIds + [ (c)-[:${EXTRACTION_TYPE}]->(ex:Episode)` +
      ` WHERE ${extracted.where} | ex.id ] AS captures`,
    'WITH c, stated, captures, $narrativeLabel IN labels(c) AS narrated,',
    `     [ id IN coalesce(c.${NARRATIVE_PROPERTIES.citations}, []) WHERE id <> c.id ] AS citations`,
    `OPTIONAL MATCH (cited:${BASE_NODE_LABEL})`,
    `WHERE cited.id IN citations AND ${cited.where}`,
    'WITH c, stated, captures, narrated, citations, cited',
    'ORDER BY cited.id',
    'WITH c, stated, captures, narrated, citations, collect(DISTINCT cited.id) AS citedIds',
    'RETURN c.id AS id,',
    '       CASE WHEN narrated THEN citedIds',
    '            WHEN size(stated) > 0 THEN stated',
    '            ELSE [ id IN captures WHERE id <> c.id ] END AS parents,',
    `       coalesce(c.${UNRESOLVED_REFERENCES_PROPERTY}, 0) AS unresolved,`,
    '       narrated AS narrated,',
    '       citations AS citations,',
    '       size(citedIds) AS resolved_citations',
  ].join('\n');
  return {
    cypher,
    parameters: {
      ...node.parameters,
      ...root.parameters,
      ...own.parameters,
      ...extracted.parameters,
      ...cited.parameters,
      narrativeLabel: NARRATIVE_LABEL,
      ids: [...new Set(ids)],
    },
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
 * The chain behind each starting capture, walked branch by branch until every branch reaches a
 * node that names nothing further.
 *
 * A path is what tells a cycle from converging ancestry. Two branches meeting at one ancestor is
 * ordinary and says nothing is wrong; a branch arriving back at a node already on its own path
 * has no end, so it contributes no root and the whole answer is reported short. A set of visited
 * ids cannot separate the two, and reading an endless branch as a finished one produced an empty
 * ancestry that called itself complete.
 *
 * `lineage` keeps every id the walk touched, the starting captures included, because that is
 * the set an overlap test needs. `roots` keeps only where the chain ended, which is what a
 * reader is shown.
 */
export function foldAncestry(
  captures: readonly string[],
  parents: ReadonlyMap<string, NodeParents>,
  maxRoots: number,
): Ancestry {
  const roots = new Set<string>();
  const lineage = new Set<string>(captures);
  const counted = new Set<string>();
  /** Where a branch stopped without reaching an end: a loop, or the hop bound. */
  const cutAt = new Set<string>();
  /** Nodes that must have come from somewhere and could not say where. */
  const unknown = new Set<string>();
  let unresolved = 0;

  function walk(id: string, path: ReadonlySet<string>): void {
    if (path.has(id)) {
      // A branch back onto its own path never ends, so it names no root and the answer is short.
      cutAt.add(id);
      return;
    }
    if (path.size > MAX_LINEAGE_HOPS) {
      cutAt.add(id);
      return;
    }
    lineage.add(id);
    const step = parents.get(id);
    if (step === undefined) {
      roots.add(id);
      return;
    }
    // Counted once per node however many branches reach it: a node that named a source the
    // substrate could not place has no edge to follow, so its reference list would otherwise go
    // unreported, and a shared ancestor would otherwise be charged for it twice.
    if (!counted.has(id)) {
      counted.add(id);
      unresolved += step.unresolved;
    }
    if (step.unknownSource === true) {
      unknown.add(id);
    }
    if (step.parents.length === 0) {
      roots.add(id);
      return;
    }
    const extended = new Set(path).add(id);
    for (const parent of step.parents) {
      walk(parent, extended);
    }
  }

  for (const capture of captures) {
    walk(capture, new Set());
  }

  const ordered = [...roots].sort();
  return {
    roots: ordered.slice(0, maxRoots),
    lineage: [...lineage],
    complete:
      cutAt.size === 0 && unknown.size === 0 && ordered.length <= maxRoots && unresolved === 0,
  };
}

/**
 * Every node the walk still has to ask about, in rounds: the starting captures, then whatever
 * they named, until nothing new comes back or the hop bound stops it. Each round is one batched
 * read, so a chain costs hops rather than nodes.
 */
export async function readAncestry(
  driver: Driver,
  captureIds: ReadonlySet<string>,
  mode: ReadMode,
): Promise<ReadonlyMap<string, NodeParents>> {
  const parents = new Map<string, NodeParents>();
  let frontier = [...captureIds];

  for (let hop = 0; hop <= MAX_LINEAGE_HOPS && frontier.length > 0; hop += 1) {
    const rows = await runRead(driver, parentStatement(frontier, mode), (row: Row) => {
      // Deduplicated here rather than in the statement: the resolved side already comes back
      // distinct, so the two counts compare only once both name each cited node at most once.
      const citations = new Set(
        ((row.citations as string[] | null) ?? []).filter((id) => id.length > 0),
      );
      const resolved = (row.resolved_citations as number | null) ?? 0;
      return {
        id: row.id as string,
        parents: ((row.parents as string[] | null) ?? []).filter((id) => id.length > 0),
        unresolved: (row.unresolved as number | null) ?? 0,
        unknownSource: row.narrated === true && (citations.size === 0 || resolved < citations.size),
      };
    });
    const next: string[] = [];
    for (const row of rows) {
      parents.set(row.id, {
        parents: row.parents,
        unresolved: row.unresolved,
        ...(row.unknownSource ? { unknownSource: true } : {}),
      });
      for (const parent of row.parents) {
        if (!parents.has(parent)) {
          next.push(parent);
        }
      }
    }
    frontier = [...new Set(next)];
  }
  return parents;
}
