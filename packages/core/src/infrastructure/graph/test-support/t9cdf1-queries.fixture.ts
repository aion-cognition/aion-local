import type { Driver } from 'neo4j-driver';

import { runWrite } from '../connection.js';

export async function restoreForgotten(driver: Driver, id: string): Promise<void> {
  await runWrite(
    driver,
    'MATCH (n:AionNode {id:$id}) REMOVE n.forgotten_at RETURN n.id AS id',
    { id },
    () => undefined,
  );
}
export async function corruptRawTurn(
  driver: Driver,
  sourceId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await runWrite(
    driver,
    'MATCH (t:Turn)-[:PARTICIPATES_IN]->(:Episode {id:$sourceId}) SET t += $patch RETURN t.id AS id',
    { sourceId, patch },
    () => undefined,
  );
}
