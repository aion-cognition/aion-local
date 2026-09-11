import type { Driver } from 'neo4j-driver';

import { runRead, runWrite } from '../connection.js';
import { toGraphParameters, type GraphProperties } from '../values.js';

export type LegacyTestNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type LegacyTestEdge = {
  type: string;
  sourceId: string;
  targetId: string;
  validUntil?: unknown;
  txUntil?: unknown;
};

/** Native graph assertions and seeding for the compatibility writer's scripted-provider tests. */
export class LegacyNarrativeGraph {
  readonly driver: Driver;
  constructor(driver: Driver) {
    this.driver = driver;
  }
  async seedNode(
    id: string,
    labels: readonly string[],
    properties: GraphProperties = {},
  ): Promise<void> {
    await runWrite(
      this.driver,
      `CREATE (n:${labels.join(':')} {id: $id}) SET n += $properties`,
      { id, properties: toGraphParameters(properties) },
      () => undefined,
    );
  }
  async seedEdge(type: string, sourceId: string, targetId: string): Promise<void> {
    await runWrite(
      this.driver,
      `MATCH (s {id: $sourceId}), (t {id: $targetId}) CREATE (s)-[:${type}]->(t)`,
      { sourceId, targetId },
      () => undefined,
    );
  }
  nodesWithLabel(label: string): Promise<LegacyTestNode[]> {
    return runRead(
      this.driver,
      `MATCH (n:${label}) RETURN n.id AS id, labels(n) AS labels, properties(n) AS properties ORDER BY id`,
      {},
      (row) => row as LegacyTestNode,
    );
  }
  async node(id: string): Promise<LegacyTestNode | undefined> {
    const rows = await runRead(
      this.driver,
      'MATCH (n {id: $id}) RETURN n.id AS id, labels(n) AS labels, properties(n) AS properties',
      { id },
      (row) => row as LegacyTestNode,
    );
    return rows[0];
  }
  edgesOfType(type: string): Promise<LegacyTestEdge[]> {
    return runRead(
      this.driver,
      `MATCH (s)-[r:${type}]->(t) RETURN s.id AS sourceId, t.id AS targetId, r.valid_until AS validUntil, r.tx_until AS txUntil ORDER BY sourceId, targetId`,
      {},
      (row) => ({
        type,
        sourceId: String(row.sourceId),
        targetId: String(row.targetId),
        ...(row.validUntil == null ? {} : { validUntil: row.validUntil }),
        ...(row.txUntil == null ? {} : { txUntil: row.txUntil }),
      }),
    );
  }
}
