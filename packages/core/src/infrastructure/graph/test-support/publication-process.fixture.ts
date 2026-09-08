import neo4j from 'neo4j-driver';
import { z } from 'zod';

import { ProbePublication } from './publication-operation.fixture.js';
import { PublicationCoordinator } from '../../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../publication/handlers.js';
import { SqliteStore } from '../../sqlite/database.js';

const Input = z.strictObject({
  uri: z.string(),
  password: z.string(),
  filePath: z.string(),
  operationId: z.string(),
  mode: z.enum(['publish', 'hold_prepared', 'hold_committed', 'sqlite_lock']),
  payload: z.record(z.string(), z.unknown()),
});
const input = Input.parse(JSON.parse(process.env.PUBLICATION_REHEARSAL_INPUT ?? 'null'));
const store = new SqliteStore({ filePath: input.filePath });

function send(value: unknown): void {
  process.send?.(value);
}
async function command(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.once('message', () => {
      resolve();
    });
  });
}

if (input.mode === 'sqlite_lock') {
  // Deliberate external contention. The coordinator itself never waits inside SQLite.
  store.db.exec('BEGIN IMMEDIATE');
  send({ event: 'locked' });
  await command();
  store.db.exec('ROLLBACK');
  store.close();
  process.disconnect();
} else {
  const driver = neo4j.driver(input.uri, neo4j.auth.basic('neo4j', input.password));
  const coordinator = new PublicationCoordinator({
    driver,
    db: store.db,
    handlers: [new ProbePublication(), ...PUBLICATION_HANDLERS],
    logger: { warn: () => undefined, error: () => undefined },
    observe: (metric) => {
      send({ event: 'metric', metric });
    },
    boundary: async ({ boundary }) => {
      if (
        (boundary === 'prepared' && input.mode === 'hold_prepared') ||
        (boundary === 'graph_committed' && input.mode === 'hold_committed')
      ) {
        send({ event: boundary });
        await command();
      }
    },
  });
  try {
    await coordinator.initialize();
    send({ event: 'ready' });
    await command();
    const outcome = await coordinator.publish({
      kind: 'semantic_write',
      operationId: input.operationId,
      payload: input.payload,
    });
    send({ event: 'done', outcome });
  } catch (err) {
    send({ event: 'failed', error: err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  } finally {
    await driver.close();
    store.close();
    process.disconnect();
  }
}
