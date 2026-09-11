import type { Driver } from 'neo4j-driver';

import { inWriteTransaction } from '../connection.js';
import { toGraphInteger } from '../values.js';

export type MigrationCorpusRow = {
  readonly id: string;
  readonly text: string;
  readonly hash: string;
  readonly occurredAt: string;
  readonly capturedAt: string;
};

/** Raw legacy projections only. The migration must create their missing identity records itself. */
export async function seedMigrationCorpus(
  driver: Driver,
  sessionId: string,
  rows: readonly MigrationCorpusRow[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 128) {
    await inWriteTransaction(driver, async (tx) => {
      await tx.run(
        `MATCH (session:Session {id: $sessionId})
        UNWIND $rows AS row
        CREATE (e:AionNode:Episode:Memory {id: row.id, text: row.text, content_hash: row.hash,
          session_id: $sessionId, occurred_at: datetime(row.occurredAt), valid_from: datetime(row.occurredAt),
          tx_from: datetime(row.capturedAt)})
        CREATE (e)-[:PARTICIPATES_IN {id: row.id + ':session', count: $zero, strength: 1.0,
          confidence: 1.0, created_at: datetime(row.capturedAt), updated_at: datetime(row.capturedAt)}]->(session)
        RETURN e.id AS id`,
        { sessionId, rows: rows.slice(offset, offset + 128), zero: toGraphInteger(0) },
        (row) => String(row.id),
      );
    });
  }
}
