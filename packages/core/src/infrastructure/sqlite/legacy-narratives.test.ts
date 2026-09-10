import { expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  readLegacyNarrative,
  recordLegacyNarrative,
  retireLegacyNarrative,
} from './legacy-narratives.js';

const NOW = new Date('2026-09-10T02:00:00.000Z');
const record = {
  narrativeId: 'legacy',
  sessionId: 'session',
  verificationStatus: 'verified' as const,
  verificationJson: '{"sources":["source"]}',
  createdAt: NOW,
};
const retirement = {
  narrativeId: 'legacy',
  sessionId: 'session',
  operationId: 'cutover',
  knownFrom: NOW.toISOString(),
  chunkIds: ['chunk-b', 'chunk-a'],
  cohortId: 'cohort',
};

it('keeps representation retirement immutable and separate from refreshed verification', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    expect(() => {
      recordLegacyNarrative(store.db, record);
    }).toThrow('publication transaction');
    store.db
      .transaction(() => {
        recordLegacyNarrative(store.db, record);
        retireLegacyNarrative(store.db, retirement);
        retireLegacyNarrative(store.db, retirement);
        recordLegacyNarrative(store.db, {
          ...record,
          verificationStatus: 'pinned',
          verificationJson: '{"reason":"new gap"}',
        });
      })
      .immediate();
    expect(readLegacyNarrative(store.db, 'legacy')).toMatchObject({
      retiredAt: NOW.toISOString(),
      verificationStatus: 'pinned',
      retirementFamilyJson: JSON.stringify({
        operationId: 'cutover',
        family: 'chunk',
        cohortId: 'cohort',
        chunkIds: ['chunk-a', 'chunk-b'],
      }),
    });
    expect(() => {
      store.db
        .transaction(() => {
          retireLegacyNarrative(store.db, {
            ...retirement,
            operationId: 'different',
          });
        })
        .immediate();
    }).toThrow('another publication');
    expect(() => {
      store.db
        .transaction(() => {
          recordLegacyNarrative(store.db, {
            ...record,
            sessionId: 'other',
          });
        })
        .immediate();
    }).toThrow('another session');
  } finally {
    store.close();
  }
});

it('does not leak retirement from an interrupted acknowledgment', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    store.db
      .transaction(() => {
        recordLegacyNarrative(store.db, record);
      })
      .immediate();
    expect(() =>
      store.db
        .transaction(() => {
          retireLegacyNarrative(store.db, retirement);
          throw new Error('interrupted');
        })
        .immediate(),
    ).toThrow('interrupted');
    expect(readLegacyNarrative(store.db, 'legacy')?.retiredAt).toBeNull();
  } finally {
    store.close();
  }
});
