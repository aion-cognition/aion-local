import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { publishContextVectorSync, type ContextVectorSyncResult } from './context-vector-demand.js';
import { ABSENT_AT_BINDING, contextVectorSyncPublication } from './context-vector-sync.js';
import { activatedCoordinator } from './test-support/publication-substrate.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { findStaleContextVectorNodes } from '../../infrastructure/graph/context-vector-sync.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { readNeighborhoodRevisionsOf } from '../../infrastructure/graph/episode-eviction.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  contextVector,
  contextVectorSyncedAt,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * The per-node dispositions, against a real graph and a real guard.
 *
 * One publication over one batch is the whole point of the operation, so the first case
 * nominates every shape at once and reads the receipt: what was written, what was cleared, what
 * was stamped, and what was held with which reason. The cases after it are the ones a single
 * batch cannot stage — a binding that no longer holds, and a batch where none of them do.
 *
 * The distinction the fixture exists for is the destructive one. `lonely`, `early` and `garbled`
 * all come out of `computeContextVectors` as nothing. Before the conversion that one empty
 * answer meant "clear it" on the repair path and "stamp it" on the scan path, and neither pass
 * could tell an empty neighbourhood from one whose vectors had not arrived.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-10T12:00:00.000Z');

function unitVector(index: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0.001);
  vector[index] = 0.995;
  return vector;
}

const HUB_VECTOR = unitVector(0);
const PEER_VECTOR = unitVector(1);
const STALE_VECTOR = unitVector(2);

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let publications: PublicationCoordinator;

/** A content-bearing node; `Entity` carries `Memory`, which every context-vector statement matches. */
async function vectored(
  id: string,
  contentVector: number[] | string[] | undefined,
  context?: number[],
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    occurredAt: NOW,
    properties: {
      name: id,
      name_norm: id,
      type: 'person',
      text: id,
      ...(contentVector === undefined ? {} : { content_vec: contentVector }),
      ...(context === undefined ? {} : { context_vec: context }),
    },
  });
}

async function link(from: string, to: string, strength: number): Promise<void> {
  await upsertEdge(harness.driver, {
    type: 'SIMILAR',
    sourceId: from,
    targetId: to,
    strength,
    confidence: 0.9,
    signals: ['semantic'],
    provenance: ['context-vector-sync-fixture'],
    count: 1,
    now: NOW,
  });
}

const MEMBERS = [
  'cvs-hub',
  'cvs-peer',
  'cvs-lonely',
  'cvs-early',
  'cvs-garbled',
  'cvs-weightless',
  'cvs-dimensionless',
  'cvs-plain',
  'cvs-nowhere',
] as const;

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-context-vector-sync-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  publications = await activatedCoordinator({ driver: harness.driver, db, logger }, 'cvs');

  // A pair that can be recomputed from each other.
  await vectored('cvs-hub', HUB_VECTOR);
  await vectored('cvs-peer', PEER_VECTOR);
  await link('cvs-hub', 'cvs-peer', 1);

  // Carries a context vector and has no neighbour at all: the one case a clear is honest for.
  await vectored('cvs-lonely', PEER_VECTOR, STALE_VECTOR);

  // A neighbour whose embedding has not arrived. The neighbourhood is not empty, only early.
  await vectored('cvs-early', PEER_VECTOR, STALE_VECTOR);
  await vectored('cvs-unembedded', undefined);
  await link('cvs-early', 'cvs-unembedded', 1);

  // A neighbour whose stored vector will not coerce to numbers: a defect, not an absence.
  await vectored('cvs-garbled', PEER_VECTOR, STALE_VECTOR);
  await vectored('cvs-unreadable', ['not', 'numbers']);
  await link('cvs-garbled', 'cvs-unreadable', 1);

  // A readable neighbourhood carrying no weight: a complete reading of nothing.
  await vectored('cvs-weightless', PEER_VECTOR, STALE_VECTOR);
  await link('cvs-weightless', 'cvs-hub', 0);

  // Weighted, stored, and unusable: an empty list coerces, so this reads as a present vector of
  // no dimension rather than as an absent one.
  await vectored('cvs-dimensionless', PEER_VECTOR, STALE_VECTOR);
  await vectored('cvs-empty-vector', []);
  await link('cvs-dimensionless', 'cvs-empty-vector', 1);

  // Present, and outside `:Memory`: `Session` is the one label with no `Memory` companion.
  await writeStampedNode(harness.driver, {
    label: 'Session',
    id: 'cvs-plain',
    now: NOW,
    occurredAt: NOW,
    properties: {},
  });
  // `cvs-nowhere` is deliberately never written.
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function holdFor(result: ContextVectorSyncResult, id: string): string | undefined {
  return result.holds.find((hold) => hold.id === id)?.reason;
}

describe('context_vector_sync over one batch of every shape', () => {
  let result: ContextVectorSyncResult;

  beforeAll(async () => {
    const outcome = await publishContextVectorSync(
      { driver: harness.driver, db, publications, now: NOW },
      {
        basis: 'staleness_scan',
        subject: null,
        members: MEMBERS.map((id) => ({ id, workId: null })),
      },
    );
    expect(outcome.status).toBe('published');
    if (outcome.status !== 'published') {
      return;
    }
    ({ result } = outcome);
  }, 120_000);

  it('accounts for every member it bound, exactly once', () => {
    const named = [...result.recomputed, ...result.cleared]
      .concat(result.holds.map((hold) => hold.id))
      .sort();

    // The invariant the operation raises on: a receipt covering fewer nodes than its intent
    // named would be a record of membership passing for a record of effect.
    expect(named).toEqual([...MEMBERS].sort());
  });

  it('recomputes and stamps the pair that can see each other', async () => {
    expect(result.recomputed).toEqual(['cvs-hub', 'cvs-peer']);
    expect(await contextVector(harness.driver, 'cvs-hub')).toEqual(PEER_VECTOR);
    expect(await contextVector(harness.driver, 'cvs-peer')).toEqual(HUB_VECTOR);
    expect(await contextVectorSyncedAt(harness.driver, 'cvs-hub')).toBeInstanceOf(Date);
  });

  /**
   * One semantic, two readings. A node with no current neighbour and a node whose every
   * neighbour was readable and carried no weight both come out CLEARED, because both are "this
   * node has no context now" and a stored vector left behind goes on being served.
   */
  it('clears both readings the guard could certify as no context, and stamps them', async () => {
    expect(result.cleared).toEqual(['cvs-lonely', 'cvs-weightless']);

    for (const id of ['cvs-lonely', 'cvs-weightless']) {
      expect(await contextVector(harness.driver, id)).toBeUndefined();
      expect(await contextVectorSyncedAt(harness.driver, id)).toBeInstanceOf(Date);
    }
  });

  it('holds an early neighbourhood instead of clearing it, and leaves the vector alone', async () => {
    expect(holdFor(result, 'cvs-early')).toBe('neighbor_vector_pending');
    expect(await contextVector(harness.driver, 'cvs-early')).toEqual(STALE_VECTOR);
    // Unstamped on purpose: the staleness scan orders on this stamp, so stamping a node nothing
    // recomputed would take it out of the queue that exists to come back for it.
    expect(await contextVectorSyncedAt(harness.driver, 'cvs-early')).toBeUndefined();
  });

  it('holds an unreadable neighbourhood as the defect it is', async () => {
    expect(holdFor(result, 'cvs-garbled')).toBe('neighbor_vector_unreadable');
    expect(await contextVector(harness.driver, 'cvs-garbled')).toEqual(STALE_VECTOR);
    expect(await contextVectorSyncedAt(harness.driver, 'cvs-garbled')).toBeUndefined();
  });

  /**
   * `weightedMeanVector` returns nothing for two unlike reasons, and only one of them is a
   * statement about the neighbourhood. A neighbour carrying weight 1 and a zero-length vector is
   * a provider defect, so it holds as a defect — it must not read as "carries no weight" and be
   * cleared and stamped out of the scan's reach on a receipt that says the wrong thing.
   */
  it('holds a weighted neighbourhood whose vectors have no usable dimension', async () => {
    expect(holdFor(result, 'cvs-dimensionless')).toBe('neighbor_vector_unreadable');
    expect(await contextVector(harness.driver, 'cvs-dimensionless')).toEqual(STALE_VECTOR);
    expect(await contextVectorSyncedAt(harness.driver, 'cvs-dimensionless')).toBeUndefined();
  });

  /**
   * The claim that used to sit in `context-vector-currency.int.test.ts` against the driver-scoped
   * stamp writer, asserted at the surface that owns every write of the property now — and its
   * other half, which is the whole argument for holding rather than stamping.
   *
   * A held member is left with `context_vec_synced_at` NULL, and that is what makes the scan
   * reach it later. The scan needs BOTH an unmoved stamp and a vectored neighbour, so a member
   * waiting on an embedding is outside the scan's population until the embedding lands — at
   * which point the NULL stamp puts it straight in. Stamping it would have required an edge to
   * move afterwards, and no edge moves when a vector arrives.
   */
  it('takes what it wrote out of the staleness scan, and leaves a held member reachable by it', async () => {
    const stale = await findStaleContextVectorNodes(harness.driver, 50);
    for (const id of [...result.recomputed, ...result.cleared]) {
      expect(stale).not.toContain(id);
    }
    // Not yet in the scan: its one neighbour carries no vector, so the scan cannot see the pair.
    expect(stale).not.toContain('cvs-early');
    expect(await contextVectorSyncedAt(harness.driver, 'cvs-early')).toBeUndefined();

    // The embedding arrives, moving no edge.
    await writeStampedNode(harness.driver, {
      label: 'Entity',
      id: 'cvs-unembedded',
      now: NOW,
      occurredAt: NOW,
      properties: {},
      mergeProperties: { content_vec: PEER_VECTOR },
    });

    // And the held member is in the scan, on the strength of the stamp the hold did not write.
    expect(await findStaleContextVectorNodes(harness.driver, 50)).toContain('cvs-early');
  });

  it('names a node it cannot write and a node that is not there', () => {
    expect(holdFor(result, 'cvs-plain')).toBe('node_not_vectored');
    expect(holdFor(result, 'cvs-nowhere')).toBe('node_absent');
  });
});

/**
 * The binding is what the guard compares, so the cases that matter most are the ones where it no
 * longer holds. Published as hand-built intents rather than staged by racing a writer against the
 * lock: the comparison is between a recorded revision and the current one, and a value the graph
 * never had exercises it exactly and without a timing window.
 */
describe('a binding the graph no longer matches', () => {
  async function publishWith(
    revisions: ReadonlyMap<string, string>,
    ids: readonly string[],
    operationId: string,
  ): Promise<{ status: string; result?: ContextVectorSyncResult; reason?: string }> {
    const outcome = await publications.publish({
      kind: contextVectorSyncPublication.kind,
      operationId,
      payload: {
        basis: 'survivor_repair',
        subject: null,
        observedAt: NOW.toISOString(),
        coverageEpoch: readCurrentCoverageContract(db)?.epoch,
        nodes: [...ids].sort().map((id) => ({
          id,
          neighborhoodRevision: revisions.get(id) ?? ABSENT_AT_BINDING,
          workId: null,
        })),
      },
    });
    if (outcome.status !== 'acknowledged') {
      return { status: outcome.status, reason: outcome.reason };
    }
    return {
      status: outcome.status,
      result: contextVectorSyncPublication.decodeResult(outcome.result),
    };
  }

  it('holds the member whose neighbourhood moved and writes the ones that did not', async () => {
    const standing = await readNeighborhoodRevisionsOf(harness.driver, ['cvs-hub', 'cvs-peer']);
    const bound = new Map(standing);
    bound.set('cvs-peer', '99:2020-01-01T00:00:00Z');

    const outcome = await publishWith(bound, ['cvs-hub', 'cvs-peer'], 'cvs-partial-drift');

    expect(outcome.status).toBe('acknowledged');
    expect(outcome.result?.recomputed).toEqual(['cvs-hub']);
    expect(outcome.result?.holds).toEqual([{ id: 'cvs-peer', reason: 'neighborhood_moved' }]);
  });

  it('refuses the batch outright when no binding stands', async () => {
    const bound = new Map([
      ['cvs-hub', '99:2020-01-01T00:00:00Z'],
      ['cvs-peer', '98:2020-01-01T00:00:00Z'],
    ]);

    const outcome = await publishWith(bound, ['cvs-hub', 'cvs-peer'], 'cvs-total-drift');

    // Deferred rather than acknowledged with a receipt of nothing but holds: an intent whose
    // every member moved describes a neighbourhood nobody holds, and the next tick re-binds.
    expect(outcome).toMatchObject({ status: 'deferred', reason: 'every_binding_moved' });
  });

  it('refuses a member set that repeats or arrives out of order', async () => {
    await expect(
      publications.publish({
        kind: contextVectorSyncPublication.kind,
        operationId: 'cvs-unsorted',
        payload: {
          basis: 'enrichment',
          subject: 'cvs-episode',
          observedAt: NOW.toISOString(),
          coverageEpoch: readCurrentCoverageContract(db)?.epoch,
          nodes: [
            { id: 'cvs-peer', neighborhoodRevision: '1:x', workId: null },
            { id: 'cvs-hub', neighborhoodRevision: '1:x', workId: null },
          ],
        },
      }),
    ).rejects.toThrow();
  });
});
