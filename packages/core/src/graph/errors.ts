/** A write was rejected before it reached the server: an unknown relationship type, an out-of-range score. */
export class GraphWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GraphWriteError';
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
