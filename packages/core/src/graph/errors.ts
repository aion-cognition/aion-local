/** A write was rejected before it reached the server: an unknown relationship type, an out-of-range score. */
export class GraphWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GraphWriteError';
  }
}

/**
 * The embedding model's dimension no longer matches the dimension the vector index was
 * built at. Neo4j rejects writes of the wrong width rather than silently truncating, so
 * this surfaces at `aion doctor` instead of as a write failure much later.
 */
export class VectorIndexDimensionMismatchError extends Error {
  readonly indexName: string;
  readonly indexDimension: number;
  readonly expectedDimension: number;

  constructor(indexName: string, indexDimension: number, expectedDimension: number, embedModel: string) {
    super(
      `vector index ${indexName} was created at ${indexDimension} dimensions but ${embedModel} produces ${expectedDimension}; reindex is required`,
    );
    this.name = 'VectorIndexDimensionMismatchError';
    this.indexName = indexName;
    this.indexDimension = indexDimension;
    this.expectedDimension = expectedDimension;
  }
}

/** A migration is recorded as applied but its index is gone from the server. */
export class VectorIndexMissingError extends Error {
  readonly indexNames: readonly string[];

  constructor(indexNames: readonly string[]) {
    super(`vector index missing from Neo4j: ${indexNames.join(', ')}`);
    this.name = 'VectorIndexMissingError';
    this.indexNames = indexNames;
  }
}

/**
 * A MATCH that bound nothing. Cypher would silently skip the rest of the statement, which
 * would turn a missing endpoint into a write that reports success and changes nothing.
 */
export class GraphNodeNotFoundError extends Error {
  readonly nodeIds: readonly string[];

  constructor(nodeIds: readonly string[], context: string) {
    super(`no graph node found for ${nodeIds.join(', ')} while running ${context}`);
    this.name = 'GraphNodeNotFoundError';
    this.nodeIds = nodeIds;
  }
}
