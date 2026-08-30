import neo4j, { type Driver } from 'neo4j-driver';
import { runRead } from './connection.js';
import { VectorIndexDimensionMismatchError, VectorIndexMissingError } from './errors.js';
import { CONTENT_VECTOR_INDEX, CONTEXT_VECTOR_INDEX } from './vector-indexes.js';

/** The two vector indexes migration 001 declares; both are built at the embedding model's dimension. */
export const VECTOR_INDEX_NAMES = [CONTENT_VECTOR_INDEX, CONTEXT_VECTOR_INDEX] as const;

export type VectorIndexInfo = {
  readonly name: string;
  readonly dimensions?: number;
  readonly similarityFunction?: string;
};

export type GraphCounts = {
  readonly nodes: number;
  readonly relationships: number;
};

const DIMENSIONS_OPTION = 'vector.dimensions';
const SIMILARITY_OPTION = 'vector.similarity_function';

function readIndexConfig(options: unknown): Record<string, unknown> {
  if (typeof options !== 'object' || options === null) {
    return {};
  }
  const indexConfig = (options as Record<string, unknown>)['indexConfig'];
  if (typeof indexConfig !== 'object' || indexConfig === null) {
    return {};
  }
  return indexConfig as Record<string, unknown>;
}

/** `SHOW INDEXES` rather than `SHOW VECTOR INDEXES` so a server without the narrower form still answers. */
export async function readVectorIndexes(driver: Driver): Promise<readonly VectorIndexInfo[]> {
  return runRead(
    driver,
    "SHOW INDEXES YIELD name, type, options WHERE type = 'VECTOR' RETURN name, options",
    {},
    (row) => {
      const config = readIndexConfig(row['options']);
      const dimensions = config[DIMENSIONS_OPTION];
      const similarity = config[SIMILARITY_OPTION];
      return {
        name: row['name'] as string,
        ...(typeof dimensions === 'number' ? { dimensions } : {}),
        ...(typeof similarity === 'string' ? { similarityFunction: similarity } : {}),
      };
    },
  );
}

/**
 * Pure comparison so the mismatch rule is testable without a server. Missing and
 * mis-dimensioned are distinct failures: the first means the schema is gone, the second
 * means the embedding model changed under a schema that is otherwise intact.
 */
export function assertVectorIndexDimensions(
  indexes: readonly VectorIndexInfo[],
  expectedDimension: number,
  embedModel: string,
): void {
  const byName = new Map(indexes.map((index) => [index.name, index]));
  const missing = VECTOR_INDEX_NAMES.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new VectorIndexMissingError(missing);
  }

  for (const name of VECTOR_INDEX_NAMES) {
    const dimensions = byName.get(name)?.dimensions;
    if (dimensions !== undefined && dimensions !== expectedDimension) {
      throw new VectorIndexDimensionMismatchError(name, dimensions, expectedDimension, embedModel);
    }
  }
}

/**
 * `OPTIONAL MATCH` on the relationship half: an empty graph would otherwise return no
 * row at all and report as an error rather than as zero.
 */
export async function countGraphElements(driver: Driver): Promise<GraphCounts> {
  const rows = await runRead(
    driver,
    `MATCH (n)
     WITH count(n) AS nodes
     OPTIONAL MATCH ()-[r]->()
     RETURN nodes, count(r) AS relationships`,
    {},
    (row) => ({ nodes: row['nodes'] as number, relationships: row['relationships'] as number }),
  );
  return rows[0] ?? { nodes: 0, relationships: 0 };
}

/**
 * One row per label a node carries, `aion stats`' substrate breakdown. A node counts under
 * every label on it (`Episode`, its `Memory` companion, and `AionNode`), so the rows are not
 * a partition of the node total; they are each label's own share of it.
 */
export async function countNodesByLabel(driver: Driver): Promise<ReadonlyMap<string, number>> {
  const rows = await runRead(
    driver,
    'MATCH (n) UNWIND labels(n) AS label RETURN label, count(*) AS count ORDER BY label',
    {},
    (row) => ({ label: row['label'] as string, count: row['count'] as number }),
  );
  return new Map(rows.map((row) => [row.label, row.count]));
}

/**
 * Every string property of every node, in pages. The redaction residue check is the only
 * caller: secret detection is deterministic, so re-running the current rules over what is
 * already stored is the one way to find material an older, leakier ruleset wrote. Paged and
 * bounded because this reads the whole substrate and runs from `aion doctor`.
 */
export async function readStoredText(
  driver: Driver,
  limit: number,
): Promise<readonly { readonly id: string; readonly text: string }[]> {
  return runRead(
    driver,
    [
      'MATCH (n)',
      'WITH n, [k IN keys(n) WHERE n[k] IS :: STRING | n[k]] AS strings',
      'WHERE size(strings) > 0',
      'RETURN n.id AS id, reduce(joined = \'\', s IN strings | joined + \' \' + s) AS text',
      'LIMIT $limit',
    ].join('\n'),
    // Neo4j rejects a JS number here: it arrives as a float and LIMIT wants an integer.
    { limit: neo4j.int(Math.trunc(limit)) },
    (row) => ({ id: String(row.id ?? ''), text: String(row.text ?? '') }),
  );
}
