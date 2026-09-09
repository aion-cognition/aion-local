import Database from 'better-sqlite3';
import neo4j from 'neo4j-driver';
import { z } from 'zod';

import { PublicationCoordinator } from '../../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../publication/handlers.js';

const input = z
  .object({ uri: z.string(), password: z.string(), filePath: z.string(), epoch: z.string() })
  .parse(JSON.parse(process.env.PUBLICATION_REHEARSAL_INPUT ?? 'null'));
// The parent already created and admitted this store. Opening it directly avoids any schema work.
const db = new Database(input.filePath, { fileMustExist: true });
db.pragma('busy_timeout=150');
const driver = neo4j.driver(input.uri, neo4j.auth.basic('neo4j', input.password));
try {
  const coordinator = new PublicationCoordinator({
    driver,
    db,
    handlers: PUBLICATION_HANDLERS,
    logger: { warn: () => undefined, error: () => undefined },
    transactionTimeoutMs: 300,
    readTimeoutMs: 300,
  });
  await coordinator.initialize();
  const outcome = await coordinator.publish({
    kind: 'coverage_activation',
    operationId: 'cross-process-activation',
    payload: { expectedEpoch: input.epoch, capabilityRevision: 1, fieldPolicyVersion: 1 },
  });
  console.log(JSON.stringify({ status: outcome.status }));
} catch (error) {
  const codes: string[] = [];
  let cursor: unknown = error;
  for (let i = 0; i < 5 && typeof cursor === 'object' && cursor !== null; i += 1) {
    if ('code' in cursor && typeof cursor.code === 'string') {
      codes.push(cursor.code);
    }
    cursor = 'cause' in cursor ? cursor.cause : undefined;
  }
  const blocked = codes.some((code) =>
    /SQLITE_BUSY|SQLITE_LOCKED|TransactionTimedOut|Lock.*Timeout/.test(code),
  );
  console.log(JSON.stringify({ status: blocked ? 'blocked' : 'error', codes }));
  if (!blocked) {
    process.exitCode = 1;
  }
} finally {
  await driver.close();
  db.close();
}
