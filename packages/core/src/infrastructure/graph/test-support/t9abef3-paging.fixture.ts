import type { Driver } from 'neo4j-driver';

import { runWrite } from '../connection.js';

/** A legacy missing clock exercises the null partition of the keyset. */
export async function clearNodeTxStart(driver: Driver, id: string): Promise<void> {
  await runWrite(driver, 'MATCH (n {id:$id}) REMOVE n.tx_from', { id }, () => undefined);
}
