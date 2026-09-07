import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { settleAndComplete, type StatedReferenceDeps } from './stated-references.js';
import * as claimQueries from '../../infrastructure/graph/claim-provenance-queries.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  ARCHIVE_SCHEMA_VERSION,
  insertExperience,
} from '../../infrastructure/sqlite/experience-archive.js';
import { listUsageEventsAfter } from '../../infrastructure/sqlite/usage-events.js';

/**
 * What a settle may acknowledge. The graph writes are stubbed because the subject is the
 * acknowledgement rather than the Cypher: a version marked applied is what every later pass reads
 * to decide the episode is finished, so anything the settle owes has to be written before it.
 */

const NOW = new Date('2026-09-06T12:00:00.000Z');
const EPISODE = 'episode-a';

let dir: string;
let store: SqliteStore;
let deps: StatedReferenceDeps;

/** Refuses only the confirmation row, so target resolution and the provenance write still pass. */
function refuseConfirmationRows(): void {
  store.db.exec(
    `CREATE TABLE refusal (enabled INTEGER NOT NULL);
     INSERT INTO refusal VALUES (1);
     CREATE TRIGGER refuse_confirmation BEFORE INSERT ON usage_events
     WHEN NEW.kind = 'memory_confirmed' AND (SELECT enabled FROM refusal) = 1
     BEGIN SELECT RAISE(ABORT, 'injected transient confirmation append failure'); END`,
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-stated-references-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  deps = {
    db: store.db,
    driver: {} as Driver,
    logger: openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'debug' }),
  };
  vi.spyOn(claimQueries, 'resolveProvenanceTargets').mockResolvedValue(new Set(['node-a']));
  vi.spyOn(claimQueries, 'writeClaimProvenance').mockResolvedValue(undefined);
  insertExperience(store.db, {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    pipelineVersion: 'v1',
    identity: 'session-a',
    sessionId: 'session-a',
    episodeId: EPISODE,
    contentHash: 'hash-a',
    occurredAt: NOW.toISOString(),
    archivedAt: NOW.toISOString(),
    lane: undefined,
    origin: undefined,
    payload: {
      observations: ['checked the runbook'],
      provenance: {
        confirmations: [{ target: 'node-a', by: 'Ryan Huber', evidence: 'runbook review' }],
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('a settle that owes a confirmation signal', () => {
  it('leaves the episode unfinished until the signal is recorded', async () => {
    refuseConfirmationRows();
    const complete = vi.fn();

    await expect(settleAndComplete(deps, EPISODE, NOW, complete)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
    expect(listUsageEventsAfter(store.db, undefined, 20)).toEqual([]);

    store.db.prepare('UPDATE refusal SET enabled = 0').run();
    await settleAndComplete(deps, EPISODE, NOW, complete);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(listUsageEventsAfter(store.db, undefined, 20)).toMatchObject([
      { kind: 'memory_confirmed', payload: { memories: ['node-a'] } },
    ]);
  });

  it('records one row when a settle that already wrote it runs again', async () => {
    const complete = vi.fn();
    await settleAndComplete(deps, EPISODE, NOW, complete);
    await settleAndComplete(deps, EPISODE, NOW, complete);

    expect(listUsageEventsAfter(store.db, undefined, 20)).toHaveLength(1);
  });
});
