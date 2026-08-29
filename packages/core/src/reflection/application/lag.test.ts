import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEnrichmentLagMs } from '../../infrastructure/sqlite/lag-samples.js';
import { enqueueReinforcementSignal } from '../../infrastructure/sqlite/reinforcement-queue.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { enqueueReflectionJob } from '../../infrastructure/sqlite/reflection-queue.js';
import { queueLagSnapshot } from './lag.js';

describe('queueLagSnapshot', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-lag-snapshot-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports an empty queue with no age and no lag samples', () => {
    const snapshot = queueLagSnapshot(store.db, 5);

    expect(snapshot.depthByLane).toEqual({ interactive: 0, bulk: 0 });
    expect(snapshot.oldestUnclaimedMs).toBeUndefined();
    expect(snapshot.exhausted).toBe(0);
    expect(snapshot.reinforcementDropped).toBe(0);
    expect(snapshot.p95EnrichmentLagMs).toBeUndefined();
  });

  it('reads depth by lane, the oldest unclaimed age, and exhausted attempts', () => {
    const now = new Date('2026-08-28T12:00:00.000Z');
    enqueueReflectionJob(store.db, 'integrate', { episode_id: 'e1' }, { lane: 'interactive' });
    enqueueReflectionJob(store.db, 'integrate', { episode_id: 'e2' }, { lane: 'bulk' });
    enqueueReflectionJob(store.db, 'integrate', { episode_id: 'e3' }, { lane: 'bulk' });
    store.db
      .prepare("UPDATE reflection_queue SET enqueued_at = ? WHERE json_extract(payload_json, '$.episode_id') = 'e2'")
      .run(new Date(now.getTime() - 90_000).toISOString());

    const snapshot = queueLagSnapshot(store.db, 5, now);

    expect(snapshot.depthByLane).toEqual({ interactive: 1, bulk: 2 });
    expect(snapshot.oldestUnclaimedMs).toBe(90_000);
    expect(snapshot.exhausted).toBe(0);
  });

  /**
   * The live shape the gauges misread: one job past its attempts, enqueued hours ago, with an
   * otherwise empty queue. It is not depth and its age is not a wait, because no worker will
   * ever claim it; the exhausted count is where it belongs and the only place it belongs.
   */
  it('keeps an exhausted job out of the depth and out of the oldest-unclaimed age', () => {
    const now = new Date('2026-08-29T08:00:00.000Z');
    enqueueReflectionJob(store.db, 'integrate', { episode_id: 'wedged' }, { lane: 'interactive' });
    store.db
      .prepare("UPDATE reflection_queue SET enqueued_at = ?, attempts = 5 WHERE json_extract(payload_json, '$.episode_id') = 'wedged'")
      .run(new Date(now.getTime() - 30_619_503).toISOString());

    const snapshot = queueLagSnapshot(store.db, 5, now);

    expect(snapshot.depthByLane).toEqual({ interactive: 0, bulk: 0 });
    expect(snapshot.oldestUnclaimedMs).toBeUndefined();
    expect(snapshot.exhausted).toBe(1);
  });

  it('surfaces the reinforcement dropped counter and the enrichment lag p95', () => {
    for (let index = 0; index < 20; index += 1) {
      enqueueReinforcementSignal(store.db, `a${String(index)}`, `b${String(index)}`, 'co_occurs', undefined, 5);
    }
    recordEnrichmentLagMs(store.db, 1000);
    recordEnrichmentLagMs(store.db, 2000);

    const snapshot = queueLagSnapshot(store.db, 5);

    expect(snapshot.reinforcementDropped).toBe(15);
    expect(snapshot.p95EnrichmentLagMs).toBe(1950);
  });
});
