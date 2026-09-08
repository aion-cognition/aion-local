import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { ownershipNominationHint } from './ownership.js';
import { EvidenceResolver } from './resolver.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import { OWNERSHIP_PROPERTIES } from '../../infrastructure/graph/ownership-summary-queries.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { recencySeeds } from '../../infrastructure/graph/recency-queries.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { nodeProperties } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import type { FusedItem } from '../../recall/domain/fusion.js';
import { servedFingerprint } from '../../recall/domain/session-dedup.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { checkedContext, seedSource } from '../test-support/evidence.fixture.js';
import {
  OwnershipProjectionPublication,
  retireOwnership,
} from '../test-support/ownership-publication.fixture.js';

/**
 * The ownership projection against the stores it actually crosses: incidence prepared in the
 * SQLite intent, the summary written in the same operation's graph transaction, and a nomination
 * that has to tell an acknowledged projection from one still in flight before its LIMIT runs.
 */

const NOW = new Date('2026-09-08T06:00:00.000Z');
const EMBED_DIMENSION = 3;
const ASKING = 'session-asking';
const OTHER = 'session-other';
const LIMIT = 2;
const logger = { warn: () => undefined, error: () => undefined };

let substrate: RehearsalSubstrate;
let dir: string;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let failAt: PublicationBoundary | undefined;
let substrateId: string;
const ids = { own: '', shared: '', background: '' };
let published = 0;

function content(marker: string): ReflectionContent {
  return { turns: [{ role: 'user', text: `a note about ${marker}` }] };
}

/** One ownership change, or the boundary that interrupted it. */
async function publish(
  nodeId: string,
  rows: readonly { readonly sourceId: string; readonly role: string }[],
): Promise<'acknowledged' | 'interrupted'> {
  published += 1;
  const operationId = `ownership-${String(published)}`;
  try {
    const outcome = await coordinator.publish({
      kind: 'semantic_write',
      operationId,
      payload: { nodeId, rows: [...rows] },
    });
    return outcome.status === 'acknowledged' ? 'acknowledged' : 'interrupted';
  } catch {
    return 'interrupted';
  }
}

function hint(): { substrateId: string; acknowledgedSequence: string } {
  const read = ownershipNominationHint(store.db);
  if (read === undefined) {
    throw new Error('the fixture substrate is paired');
  }
  return read;
}

async function nominate(
  overrides: Partial<{ substrateId: string; acknowledgedSequence: string }> = {},
): Promise<readonly string[]> {
  const rows = await recencySeeds(substrate.harness.driver, {
    limit: LIMIT,
    mode: withCurrency(),
    ownership: { sessionId: ASKING, ...hint(), ...overrides },
  });
  return rows.map((row) => row.id);
}

async function nominateWithoutHint(): Promise<readonly string[]> {
  const rows = await recencySeeds(substrate.harness.driver, {
    limit: LIMIT,
    mode: withCurrency(),
  });
  return rows.map((row) => row.id);
}

async function storedSummary(id: string): Promise<Record<string, unknown>> {
  return nodeProperties(substrate.harness.driver, id);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-ownership-int-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: EMBED_DIMENSION });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, new OwnershipProjectionPublication()],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted before acknowledgment');
      }
    },
  });
  await coordinator.initialize();
  substrateId = readSubstratePairing(store.db)?.substrateId ?? '';

  for (const [sourceId, sessionId] of [
    ['episode-own', ASKING],
    ['episode-other', OTHER],
  ] as const) {
    seedSource(store.db, {
      sourceId,
      sessionId,
      identity: 'agent-1',
      content: content(sourceId),
      now: NOW,
    });
  }

  // Oldest first, so the recency ordering alone puts `own` at the front of the limit.
  for (const [key, at] of [
    ['background', new Date('2026-08-01T00:00:00.000Z')],
    ['shared', new Date('2026-08-05T00:00:00.000Z')],
    ['own', new Date('2026-08-10T00:00:00.000Z')],
  ] as const) {
    const written = await writeStampedNode(substrate.harness.driver, {
      label: 'Episode',
      occurredAt: at,
      now: at,
      properties: { summary: `the ${key} memory` },
    });
    ids[key] = written.id;
  }

  await publish(ids.own, [{ sourceId: 'episode-own', role: 'extraction' }]);
  await publish(ids.shared, [
    { sourceId: 'episode-own', role: 'extraction' },
    { sourceId: 'episode-other', role: 'mention' },
  ]);
}, 180_000);

afterEach(async () => {
  failAt = undefined;
  await coordinator.recover();
});

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

describe('the ownership projection across both stores', () => {
  it('writes the summary the acknowledgment then makes trustworthy', async () => {
    const summary = await storedSummary(ids.shared);

    expect(summary[OWNERSHIP_PROPERTIES.sessions]).toEqual([ASKING, OTHER]);
    expect(summary[OWNERSHIP_PROPERTIES.unknownAttribution]).toBe(false);
    expect(summary[OWNERSHIP_PROPERTIES.census]).toBe(true);
    expect(summary[OWNERSHIP_PROPERTIES.substrate]).toBe(substrateId);
  });

  /**
   * The discount decides which memories reach the spread at all. Recency ranks the asking
   * session's own record last, so with the limit in force the ordering has to be right before it
   * runs: nothing downstream can recover a candidate the limit already dropped.
   */
  it('changes which candidates survive the limit', async () => {
    expect(await nominateWithoutHint()).toEqual([ids.own, ids.shared]);
    expect(await nominate()).toEqual([ids.shared, ids.background]);
  });

  /**
   * The proving direction. The graph now says this memory belongs to the asking session alone,
   * and nothing has acknowledged that yet, so the ordering must not act on it.
   */
  it('refuses to discount a shared memory whose own-only summary is not acknowledged', async () => {
    retireOwnership(store.db, ids.shared, 'episode-other');
    failAt = 'before_ack';
    const outcome = await publish(ids.shared, [{ sourceId: 'episode-own', role: 'extraction' }]);

    expect(outcome).toBe('interrupted');
    expect(await storedSummary(ids.shared)).toMatchObject({
      [OWNERSHIP_PROPERTIES.sessions]: [ASKING],
    });
    expect(await nominate()).toContain(ids.shared);

    // Recovery finishes the operation, and the discounted ordering it describes returns.
    await coordinator.recover();
    expect(await nominate()).not.toContain(ids.shared);
  });

  /**
   * The permissive direction, which passes on its own for the wrong reason: the uncertified value
   * withholds no discount either way. It is here so the pair says the rule holds in both.
   */
  it('keeps a candidate whose shared summary is not acknowledged either', async () => {
    failAt = 'before_ack';
    const outcome = await publish(ids.own, [
      { sourceId: 'episode-own', role: 'extraction' },
      { sourceId: 'episode-other', role: 'mention' },
    ]);

    expect(outcome).toBe('interrupted');
    expect(await nominate()).toContain(ids.own);

    await coordinator.recover();
    expect(await storedSummary(ids.own)).toMatchObject({
      [OWNERSHIP_PROPERTIES.sessions]: [ASKING, OTHER],
    });
    expect(await nominate()).toContain(ids.own);
  });

  /** An old bound preserves extra candidates and loses none, which is why a stale one is safe. */
  it('discounts nothing against a bound older than every summary', async () => {
    const preserved = await nominate({ acknowledgedSequence: '0' });

    expect(preserved).toEqual(await nominateWithoutHint());
    expect(preserved).toContain(ids.own);
  });

  it('discounts nothing when no bound can be read at all', async () => {
    store.db.prepare('ALTER TABLE publication_control RENAME TO publication_control_probe').run();
    try {
      expect(ownershipNominationHint(store.db)).toBeUndefined();
    } finally {
      store.db.prepare('ALTER TABLE publication_control_probe RENAME TO publication_control').run();
    }
    expect(await nominateWithoutHint()).toContain(ids.own);
  });

  /** A number from another restored pair is a number about somebody else's operations. */
  it('certifies nothing from a watermark belonging to a different substrate', async () => {
    const foreign = await nominate({ substrateId: 'a-different-substrate' });

    expect(foreign).toEqual(await nominateWithoutHint());
    expect(foreign).toContain(ids.own);
  });

  /**
   * An operation that moves no incidence leaves the derived answer where it was, so the stored
   * sequence keeps pointing at the acknowledgment that established it and the summary stays
   * trusted.
   */
  it('leaves a summary untouched when an operation changes no incidence', async () => {
    const before = await storedSummary(ids.background);
    await publish(ids.background, [{ sourceId: 'episode-other', role: 'mention' }]);
    const established = await storedSummary(ids.background);

    expect(before[OWNERSHIP_PROPERTIES.version]).toBeUndefined();
    expect(established[OWNERSHIP_PROPERTIES.version]).toBeDefined();

    await publish(ids.background, []);

    expect(await storedSummary(ids.background)).toEqual(established);
  });
});

describe('the fingerprint the serving layer stores', () => {
  function item(id: string): FusedItem {
    return {
      id,
      labels: ['Episode', 'Memory', 'AionNode'],
      content: 'the migration took 45 seconds',
      rationale: { method: 'vector', score: 0.8 },
      relevance: 0.8,
      measured: 0.8,
      score: 0.02,
      currency: 'current',
    };
  }

  async function fingerprintOf(id: string): Promise<string> {
    const resolver = new EvidenceResolver({
      driver: substrate.harness.driver,
      db: store.db,
      logger,
    });
    const batch = await resolver.resolveMetadata([id], checkedContext(), { maxRoots: 8 });
    const value = batch.results.get(`["id","${id}"]`)?.value;
    if (value === undefined) {
      throw new Error(`the resolver answered for ${id}`);
    }
    return servedFingerprint(item(id), value.provenance);
  }

  /**
   * Where a source's raw projection sits is not what a memory says, so moving it must not tell a
   * session the memory changed. Residency is outside the hash on purpose and this pins it against
   * a real transition rather than against a hand-built record.
   */
  it('holds still across a residency transition', async () => {
    const before = await fingerprintOf(ids.own);
    transitionSourceResidency(store.db, {
      sourceId: 'episode-own',
      state: 'evicted',
      operationId: 'evict-own',
      transitionedAt: NOW,
    });

    expect(await fingerprintOf(ids.own)).toBe(before);
  });
});
