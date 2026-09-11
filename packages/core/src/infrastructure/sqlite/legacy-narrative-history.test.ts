import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  acknowledgeLegacyOriginalClock,
  readLegacyOriginalClock,
} from './legacy-narrative-history.js';
import { recordLegacyNarrative, readLegacyNarrative } from './legacy-narratives.js';
import { preparePublicationIntent, acknowledgePublicationIntent } from './publication-intents.js';

const ORIGINAL = new Date('2026-01-01T00:00:00Z');
const INVENTORY = new Date('2026-09-10T00:00:00Z');
it('retrofits a nullable copied-clock field and exposes only acknowledged inventory history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aion-legacy-history-'));
  const path = join(directory, 'store.sqlite');
  const old = new Database(path);
  old.exec(
    `CREATE TABLE legacy_narratives (narrative_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,family TEXT NOT NULL DEFAULT 'legacy_session_overview',verification_status TEXT NOT NULL,verification_json TEXT,published_operation_id TEXT,published_known_from TEXT,retired_at TEXT,retirement_family_json TEXT,created_at TEXT NOT NULL)`,
  );
  old.close();
  const store = new SqliteStore({ filePath: path });
  try {
    store.db
      .transaction(() => {
        recordLegacyNarrative(store.db, {
          narrativeId: 'legacy',
          sessionId: 'session',
          verificationStatus: 'verified',
          verificationJson: '{}',
          createdAt: INVENTORY,
        });
      })
      .immediate();
    expect(readLegacyNarrative(store.db, 'legacy')?.originalPublicationJson).toBeNull();
    preparePublicationIntent(store.db, {
      operationId: 'inventory',
      kind: 'family_cutover',
      payloadDigest: 'fixture',
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '[]',
      createdAt: INVENTORY,
    });
    expect(() =>
      store.db
        .transaction(() => {
          acknowledgeLegacyOriginalClock(store.db, 'legacy', ORIGINAL.toISOString(), 'inventory');
          expect(
            readLegacyOriginalClock(store.db, readLegacyNarrative(store.db, 'legacy')!),
          ).toBeUndefined();
          throw new Error('rollback acknowledgment');
        })
        .immediate(),
    ).toThrow('rollback acknowledgment');
    expect(readLegacyNarrative(store.db, 'legacy')?.originalPublicationJson).toBeNull();
    store.db
      .transaction(() => {
        acknowledgeLegacyOriginalClock(store.db, 'legacy', ORIGINAL.toISOString(), 'inventory');
        acknowledgePublicationIntent(store.db, {
          operationId: 'inventory',
          resultDigest: 'fixture',
          resultJson: '{}',
          observedAckAt: INVENTORY,
        });
      })
      .immediate();
    expect(readLegacyOriginalClock(store.db, readLegacyNarrative(store.db, 'legacy')!)).toBe(
      ORIGINAL.toISOString(),
    );
    store.db
      .transaction(() => {
        acknowledgeLegacyOriginalClock(store.db, 'legacy', INVENTORY.toISOString(), 'inventory');
      })
      .immediate();
    expect(readLegacyOriginalClock(store.db, readLegacyNarrative(store.db, 'legacy')!)).toBe(
      ORIGINAL.toISOString(),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
