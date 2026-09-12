import neo4j from 'neo4j-driver';
import { z } from 'zod';

import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../installed-publications.js';

/**
 * A second process that evicts, or that arrives to finish somebody else's eviction.
 *
 * The contention this exists for is not a race inside one process. There is one receipt on the
 * substrate, and a writer meets whatever operation is occupying it before it can publish its own,
 * so the question is what a separate process does when it finds a pending eviction: the composition
 * that installed every handler recovers it, and a composition that did not cannot and says so.
 * Only separate processes contend through POSIX file locks and a dropped Bolt connection, so only
 * separate processes can answer it.
 *
 * The payload is built by the parent and handed over as JSON. Everything that makes a source
 * eligible is vitest-hooked fixture work this process cannot run, and it does not need to: what it
 * needs is the substrate's address and one attempt's binding.
 */

const Input = z.strictObject({
  uri: z.string(),
  password: z.string(),
  filePath: z.string(),
  operationId: z.string(),
  mode: z.enum(['hold_prepared', 'hold_committed', 'recover_installed', 'recover_partial']),
  payload: z.record(z.string(), z.unknown()),
  /**
   * The parent's clock, not this process's.
   *
   * The acknowledgment stamp only moves forward on the control record, and the eligibility fence
   * compares a chunk head's stamp against the run's own clock. A child acknowledging under wall
   * time would push every later stamp on this substrate past the fixture's fixed moment and pin
   * every source after it on its age.
   */
  now: z.string(),
});

const input = Input.parse(JSON.parse(process.env.EVICTION_REHEARSAL_INPUT ?? 'null'));
const store = new SqliteStore({ filePath: input.filePath });
const driver = neo4j.driver(input.uri, neo4j.auth.basic('neo4j', input.password));

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

const recovering = input.mode.startsWith('recover');
const coordinator = new PublicationCoordinator({
  driver,
  db: store.db,
  // The control composes the one-entry set a command that installed nothing would have. It meets
  // a pending operation of a kind it does not know, which is the refusal the shared set exists to
  // make impossible for a kind the service does install.
  handlers:
    input.mode === 'recover_partial'
      ? [...PUBLICATION_HANDLERS]
      : [...INSTALLED_PUBLICATION_HANDLERS],
  logger: { warn: () => undefined, error: () => undefined },
  now: () => new Date(input.now),
  boundary: async ({ boundary }) => {
    if (
      (boundary === 'prepared' && input.mode === 'hold_prepared') ||
      (boundary === 'graph_committed' && input.mode === 'hold_committed')
    ) {
      send({ event: boundary });
      // Held open until the parent kills this process, which is the window the receipt is for.
      await command();
    }
  },
});

try {
  await coordinator.initialize();
  send({ event: 'ready' });
  await command();
  const outcome = recovering
    ? await coordinator.recover()
    : await coordinator.publish({
        kind: 'episode_eviction',
        operationId: input.operationId,
        payload: input.payload,
      });
  send({ event: 'done', outcome: outcome ?? { status: 'nothing_pending' } });
} catch (err) {
  send({ event: 'failed', error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
} finally {
  await driver.close();
  store.close();
  process.disconnect();
}
