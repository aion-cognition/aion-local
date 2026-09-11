import type { Driver } from 'neo4j-driver';

import { coverageKey } from '../../../reflection/domain/narrative.js';
import { writeStampedDerivedNodeInTransaction } from '../bitemporal.js';
import { inWriteTransaction, runRead, runWrite } from '../connection.js';
import { upsertEdgeInTransaction } from '../edges.js';
import { DERIVES_FROM_TYPE, SUMMARIZED_BY_TYPE } from '../narrative-queries.js';

/** The original graph-only whole-session representation, with its complete source coverage. */
export async function seedLegacyFamilyVersion(
  driver: Driver,
  input: {
    readonly nodeId: string;
    readonly sessionId: string;
    readonly sources: readonly string[];
    readonly now: Date;
  },
): Promise<void> {
  await inWriteTransaction(driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: 'Narrative',
      id: input.nodeId,
      now: input.now,
      occurredAt: new Date(input.now.getTime() - 86_400_000),
      properties: {
        session_id: input.sessionId,
        scope: 'session',
        version: 1,
        coverage_key: coverageKey(input.sources),
        coverage_count: input.sources.length,
        text: 'The original whole-session narrative.',
        summary: 'Original legacy summary.',
        citations: [...input.sources],
        coverage: 1,
      },
    });
    await upsertEdgeInTransaction(tx, {
      type: DERIVES_FROM_TYPE,
      sourceId: input.nodeId,
      targetId: input.sessionId,
      strength: 1,
      confidence: 1,
      signals: [],
      provenance: [],
      count: 0,
      now: input.now,
    });
    for (const sourceId of input.sources) {
      await upsertEdgeInTransaction(tx, {
        type: SUMMARIZED_BY_TYPE,
        sourceId,
        targetId: input.nodeId,
        strength: 1,
        confidence: 1,
        signals: [],
        provenance: [],
        count: 0,
        now: input.now,
      });
    }
  });
}

/** Raw properties are compared so a representation flip cannot rewrite either temporal axis. */
export async function legacyFamilySnapshot(
  driver: Driver,
  nodeId: string,
): Promise<Record<string, unknown>> {
  const rows = await runRead(
    driver,
    [
      'MATCH (n:Narrative {id: $nodeId})',
      'OPTIONAL MATCH (n)-[:SUPERSEDES]-(s)',
      'RETURN properties(n) AS properties, count(s) AS supersession_edges',
    ].join('\n'),
    { nodeId },
    (row) => row,
  );
  return rows[0]!;
}

/** A missing original transaction stamp is distinct from a backdated world occurrence. */
export async function setSourceCaptureClock(
  driver: Driver,
  sourceId: string,
  stamp: string | null,
): Promise<void> {
  await runWrite(
    driver,
    {
      cypher:
        'MATCH (e:Episode {id: $sourceId}) SET e.tx_from = CASE WHEN $stamp IS NULL THEN null ELSE datetime($stamp) END',
      parameters: { sourceId, stamp },
    },
    () => undefined,
  );
}
