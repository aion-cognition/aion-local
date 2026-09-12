import { beforeAll, expect, it } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import {
  sourceSuppressionOperationId,
  sourceSuppressionPublication,
} from './source-suppression.js';
import {
  acceptSource,
  activateCoverage,
  driver,
  NOW,
  publications,
  store,
} from './test-support/t10b-review.fixture.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { nodeProperties } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import {
  hasPendingSourceState,
  isSourceForgotten,
  listSourceStateVersions,
} from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * `aion forget` and `aion unforget` end to end, through the coordinator that now owns them.
 *
 * The kind was declared and reserved with no handler behind it for the whole build, which meant
 * the command wrote the graph stamp through the driver and left nothing durable saying anybody
 * had said it. These cases hold both halves together: the stamp and the statement land under one
 * receipt, a refused act leaves neither, and a composition without the handler still refuses
 * loudly rather than writing outside the protocol.
 */

const logger = { warn: () => undefined, error: () => undefined };

beforeAll(async () => {
  await activateCoverage();
});

async function act(kind: 'forget' | 'unforget', nodeId: string, at: Date) {
  return await publications.publish({
    kind: sourceSuppressionPublication.kind,
    operationId: sourceSuppressionOperationId(kind, nodeId, at),
    payload: { act: kind, nodeId, observedAt: at.toISOString() },
  });
}

function stamped(properties: Record<string, unknown>): boolean {
  return properties[BITEMPORAL_PROPERTIES.forgottenAt] !== undefined;
}

it('lands the stamp and the statement under one receipt, and takes both back', async () => {
  const sourceId = await acceptSource('suppression:round-trip', 'a statement to forget');

  const forgotten = await act('forget', sourceId, NOW);
  expect(forgotten.status).toBe('acknowledged');
  expect(stamped(await nodeProperties(driver, sourceId))).toBe(true);
  expect(isSourceForgotten(store.db, sourceId)).toBe(true);
  expect(hasPendingSourceState(store.db, sourceId)).toBe(false);

  const reopened = await act('unforget', sourceId, new Date(NOW.getTime() + 1000));
  expect(reopened.status).toBe('acknowledged');
  expect(stamped(await nodeProperties(driver, sourceId))).toBe(false);
  expect(isSourceForgotten(store.db, sourceId)).toBe(false);
  // The forget is still on the record. A `knew_at` read from before the reversal still finds the
  // substrate believing the node was gone, which is the whole reason the chain is append-only.
  expect(listSourceStateVersions(store.db, sourceId).map((entry) => entry.stateKind)).toEqual([
    'forgotten',
    'unforgotten',
  ]);
});

it('refuses a second forget and leaves no statement owed behind it', async () => {
  const sourceId = await acceptSource('suppression:repeat', 'forget me once');
  expect((await act('forget', sourceId, NOW)).status).toBe('acknowledged');

  const again = await act('forget', sourceId, new Date(NOW.getTime() + 2000));
  expect(again).toMatchObject({ status: 'deferred', reason: 'already_forgotten' });
  // The refused attempt prepared nothing that survives it. A statement left with no `known_from`
  // is read as a decision about to move, by every caller whose answer turns on this source.
  expect(hasPendingSourceState(store.db, sourceId)).toBe(false);
  expect(listSourceStateVersions(store.db, sourceId)).toHaveLength(1);
});

it('refuses an unforget on a node that was never forgotten', async () => {
  const sourceId = await acceptSource('suppression:not-forgotten', 'still here');

  expect(await act('unforget', sourceId, NOW)).toMatchObject({
    status: 'deferred',
    reason: 'not_forgotten',
  });
  expect(hasPendingSourceState(store.db, sourceId)).toBe(false);
  expect(listSourceStateVersions(store.db, sourceId)).toEqual([]);
});

it('refuses an act on an id the graph does not hold', async () => {
  expect(await act('forget', 'episode-nowhere', NOW)).toMatchObject({
    status: 'deferred',
    reason: 'node_absent',
  });
  expect(hasPendingSourceState(store.db, 'episode-nowhere')).toBe(false);
});

it('refuses the kind outright in a composition that does not install the handler', async () => {
  const partial = new PublicationCoordinator({
    driver,
    db: store.db,
    logger,
    now: () => NOW,
    handlers: INSTALLED_PUBLICATION_HANDLERS.filter(
      (handler) => handler.kind !== sourceSuppressionPublication.kind,
    ),
  });
  await partial.initialize();

  // What every composition answered before the handler existed. Reserving a kind with nothing
  // behind it is the correct refusal for a kind nobody implements and the wrong one for a kind
  // the service installs, which is why the gap was worth closing rather than documenting.
  await expect(
    partial.publish({
      kind: sourceSuppressionPublication.kind,
      operationId: 'suppression:uninstalled',
      payload: { act: 'forget', nodeId: 'episode-nowhere', observedAt: NOW.toISOString() },
    }),
  ).rejects.toThrow('operation_kind_unavailable');
});
