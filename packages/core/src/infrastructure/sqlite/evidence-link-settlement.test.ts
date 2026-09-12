import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import { prepareMaterializedLinkVersion } from './evidence-link-materialization.js';
import {
  heldDeliveryLinkVersions,
  releaseLinkVersions,
  unsettledLinkStates,
} from './evidence-link-settlement.js';
import { evidenceLinkId, prepareStatedLinkVersion, statedLinkId } from './evidence-links.js';

/**
 * The delivery-scoped read, and the class boundary it holds.
 *
 * A delivery key is caller text and every writer keys its versions by the same colon shape, so the
 * key alone does not say which writer wrote a row. The read answers for stated versions only, and
 * the release built on it cannot reach a materialization or a retirement even when a delivery key
 * is chosen to collide with one.
 */

const OBSERVED_AT = new Date('2026-09-11T06:00:00.000Z');
const SOURCE = 'source-1';
const DELIVERY = 'delivery-1';

describe('the versions one delivery still holds', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-link-settlement-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function stated(toId: string): string {
    const linkId = statedLinkId('derived_from', 'source', SOURCE, toId);
    prepareStatedLinkVersion(store.db, {
      linkId,
      kind: 'derived_from',
      qualifier: 'source',
      fromId: SOURCE,
      toId,
      operationId: 'op-stated',
      operationKey: `${DELIVERY}:${linkId}`,
      recordedValues: {},
      temporalProof: {},
      observedAt: OBSERVED_AT,
      referenceSourceId: SOURCE,
      referenceVersion: 1,
    });
    return linkId;
  }

  /** A materialization whose key is exactly what this delivery's key would rebuild for it. */
  function collidingMaterialization(toId: string): string {
    const linkId = evidenceLinkId('mentions', 'claim', SOURCE, toId);
    prepareMaterializedLinkVersion(store.db, {
      linkId,
      kind: 'mentions',
      qualifier: 'claim',
      fromId: SOURCE,
      toId,
      originalRelId: `rel-${toId}`,
      operationId: 'op-materialize',
      operationKey: `${DELIVERY}:${linkId}`,
      recordedValues: {},
      temporalProof: {},
      observedAt: OBSERVED_AT,
    });
    return linkId;
  }

  it('returns the stated versions this delivery wrote', () => {
    const linkId = stated('target-1');

    expect(heldDeliveryLinkVersions(store.db, SOURCE, DELIVERY)).toEqual([
      { linkId, operationKey: `${DELIVERY}:${linkId}` },
    ]);
  });

  it('leaves another class out of the answer even under a key that matches it', () => {
    const statedLink = stated('target-1');
    const materializedLink = collidingMaterialization('target-2');

    expect(heldDeliveryLinkVersions(store.db, SOURCE, DELIVERY)).toEqual([
      { linkId: statedLink, operationKey: `${DELIVERY}:${statedLink}` },
    ]);
    expect(unsettledLinkStates(store.db, SOURCE)).toEqual(['materialized', 'stated']);
    expect(materializedLink).not.toBe(statedLink);
  });

  it('releases only the stated versions, so a colliding materialization survives', () => {
    stated('target-1');
    collidingMaterialization('target-2');

    const released = releaseLinkVersions(
      store.db,
      heldDeliveryLinkVersions(store.db, SOURCE, DELIVERY),
    );

    expect(released).toBe(1);
    expect(unsettledLinkStates(store.db, SOURCE)).toEqual(['materialized']);
  });
});
