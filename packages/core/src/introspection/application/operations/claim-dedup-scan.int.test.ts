import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimDedupOperation } from './claim-dedup.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { nodeProperties } from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { claimDedupPairKey, claimDedupScanKey } from '../../domain/claim-dedup.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * The scan-progress half of `claim_dedup`, kept in its own file so its own-dimension vectors
 * never have to share a graph with `claim-dedup.int.test.ts`'s: every scenario here gets a
 * disjoint slice of one wide embedding space, so a leftover current claim from an earlier `it`
 * in this file can never register as anyone else's nearest neighbor by accident.
 *
 * Dimension budget: 0-9 ten mutually orthogonal fillers, 10-11 the far pair the window-growth
 * test must reach, 12-13 the judge-failure pair, 14-15 the two solo claims the last test seeds
 * one run apart.
 */
const EMBED_DIMENSION = 16;

function oneHot(index: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 1;
  return vector;
}

function nearDup(index: number): number[] {
  const vector = new Array<number>(EMBED_DIMENSION).fill(0);
  vector[index] = 0.98;
  vector[index + 1] = 0.05;
  return vector;
}

const NOW = new Date('2026-08-31T14:00:00.000Z');
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const secondsAgo = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `episode ${id}`, session_id: 'session-1' },
  });
}

async function seedClaim(input: {
  readonly episodeId: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly occurredAt: Date;
}): Promise<string> {
  await seedEpisode(input.episodeId);
  const result = await writeCognitiveNode(harness.driver, {
    episodeId: input.episodeId,
    label: 'Concept',
    text: input.text,
    contentVector: input.vector,
    occurredAt: input.occurredAt,
    now: NOW,
  });
  return result.node.id;
}

/** Sequential canned answers, so a test controls exactly what each judge call decides. */
function scriptedProvider(...answers: unknown[]): Provider {
  let call = 0;
  return {
    embed: () => Promise.reject(new Error('claim dedup must never embed')),
    generate: () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return Promise.resolve(answer);
    },
  };
}

/** Fails every call, so a test can prove a failure leaves both the pair and the subject unstamped. */
const failingProvider: Provider = {
  embed: () => Promise.reject(new Error('claim dedup must never embed')),
  generate: () => Promise.reject(new Error('the judge is unavailable')),
};

function contextFor(provider: Provider, config: Config = DEFAULTS): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    provider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-dedup-scan-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('claimDedupOperation scan progress against a live graph', () => {
  it('stamps the newest window clean, then grows past it to reach and merge an older pair', async () => {
    const batchOne: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, claimDedupBatch: 1 },
    };

    const fillerIds: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = await seedClaim({
        episodeId: `ep-filler-${String(index)}`,
        text: `unrelated fact number ${String(index)}`,
        vector: oneHot(index),
        occurredAt: secondsAgo(index + 1),
      });
      fillerIds.push(id);
    }
    // Older than every filler by twenty minutes, so the first run's ten-item window (batch 1
    // times the scan's own tenfold factor) never reaches this pair at all.
    const olderId = await seedClaim({
      episodeId: 'ep-far-older',
      text: 'the export job runs nightly',
      vector: oneHot(10),
      occurredAt: minutesAgo(21),
    });
    const newerId = await seedClaim({
      episodeId: 'ep-far-newer',
      text: 'the nightly export job runs once a day',
      vector: nearDup(10),
      occurredAt: minutesAgo(20),
    });

    const first = await claimDedupOperation().run(contextFor(refusingProvider, batchOne));
    expect(first.status).toBe('noop');
    expect(first.itemsProcessed).toBe(0);
    for (const id of fillerIds) {
      expect(getLedgerEntry(db, claimDedupScanKey(id))?.summary).toMatchObject({
        verdict: 'clean',
      });
    }
    expect(getLedgerEntry(db, claimDedupScanKey(olderId))).toBeUndefined();
    expect(getLedgerEntry(db, claimDedupScanKey(newerId))).toBeUndefined();

    const provider = scriptedProvider(
      { same: true, rationale: 'both describe the same schedule' },
      { either_adds_information: false, reason: 'no fact, scope, or qualifier differs' },
    );
    const second = await claimDedupOperation().run(contextFor(provider, batchOne));

    expect(second.status).toBe('applied');
    expect(second.itemsProcessed).toBe(1);
    expect(second.itemsAffected).toBe(1);
    expect(second.detail).toBe(
      '1 pair(s) judged: 1 merged, 0 related, 0 vetoed, 0 stale, 0 failed',
    );
    // First assertion wins: the older claim survives, the newer closes with lineage to it.
    expect((await nodeProperties(harness.driver, olderId)).valid_until).toBeUndefined();
    expect((await nodeProperties(harness.driver, newerId)).valid_until).toBeDefined();
    expect(getLedgerEntry(db, claimDedupPairKey(olderId, newerId))?.summary).toMatchObject({
      verdict: 'merged',
      survivorId: olderId,
      loserId: newerId,
    });
    // The newer claim was this run's subject and is stamped; the older claim was only ever
    // found as a neighbor here, so it earns its own scan stamp on a future turn as a subject.
    expect(getLedgerEntry(db, claimDedupScanKey(newerId))?.summary).toMatchObject({
      verdict: 'merged',
    });
    expect(getLedgerEntry(db, claimDedupScanKey(olderId))).toBeUndefined();
  }, 120_000);

  it('leaves a failed judge unstamped, so a later run retries the same pairing', async () => {
    const subjectId = await seedClaim({
      episodeId: 'ep-judge-fail-newer',
      text: 'the retry limit is three attempts',
      vector: nearDup(12),
      occurredAt: minutesAgo(1),
    });
    const neighborId = await seedClaim({
      episodeId: 'ep-judge-fail-older',
      text: 'retries are capped at three attempts',
      vector: oneHot(12),
      occurredAt: minutesAgo(2),
    });
    const pairKey = claimDedupPairKey(subjectId, neighborId);

    const failed = await claimDedupOperation().run(contextFor(failingProvider));
    expect(failed.itemsAffected).toBe(0);
    expect(failed.detail).toContain('1 failed');
    expect(getLedgerEntry(db, pairKey)).toBeUndefined();
    expect(getLedgerEntry(db, claimDedupScanKey(subjectId))).toBeUndefined();

    const retried = await claimDedupOperation().run(
      contextFor(
        scriptedProvider(
          { same: true, rationale: 'both cap retries at three' },
          { either_adds_information: false, reason: 'no fact, scope, or qualifier differs' },
        ),
      ),
    );
    expect(retried.itemsProcessed).toBe(1);
    expect(retried.itemsAffected).toBe(1);
    expect(getLedgerEntry(db, pairKey)?.summary).toMatchObject({ verdict: 'merged' });
    expect(getLedgerEntry(db, claimDedupScanKey(subjectId))?.summary).toMatchObject({
      verdict: 'merged',
    });
  }, 120_000);

  it('scans a node once, and a node entering later gets its own single turn', async () => {
    const firstId = await seedClaim({
      episodeId: 'ep-solo-first',
      text: 'the cache warms on startup',
      vector: oneHot(14),
      occurredAt: minutesAgo(1),
    });

    const runA = await claimDedupOperation().run(contextFor(refusingProvider));
    expect(runA.itemsProcessed).toBe(0);
    const stampedAfterA = getLedgerEntry(db, claimDedupScanKey(firstId));
    expect(stampedAfterA?.summary).toMatchObject({ verdict: 'clean' });

    // A node entering the population after the first run: its own scan, not a rescan of the
    // node the first run already settled.
    const secondId = await seedClaim({
      episodeId: 'ep-solo-second',
      text: 'the cache flushes on shutdown',
      vector: oneHot(15),
      occurredAt: NOW,
    });

    const runB = await claimDedupOperation().run(contextFor(refusingProvider));
    expect(runB.itemsProcessed).toBe(0);
    expect(getLedgerEntry(db, claimDedupScanKey(secondId))?.summary).toMatchObject({
      verdict: 'clean',
    });
    // The first claim's stamp is untouched by the second run: `markLedgerApplied` would bump
    // `appliedAt` on a re-mark, and it has not moved.
    expect(getLedgerEntry(db, claimDedupScanKey(firstId))?.appliedAt).toBe(
      stampedAfterA?.appliedAt,
    );
  }, 120_000);
});
