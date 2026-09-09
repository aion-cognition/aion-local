import { afterEach, beforeEach, expect, it } from 'vitest';

import { planSourceVerification, applySourceVerification } from './legacy-verification.js';
import { seedSource, commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import type { LegacyRawNodes } from '../../infrastructure/graph/legacy-evidence-queries.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  insertExperience,
  getExperienceByEpisode,
} from '../../infrastructure/sqlite/experience-archive.js';
import { archiveRowidBounds } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import { prepareEpisode, type ReflectionContent } from '../domain/content.js';

const NOW = new Date('2026-09-09T00:00:00.000Z');
let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});
afterEach(() => {
  store.close();
});
function seed(content: ReflectionContent): LegacyRawNodes {
  const prepared = prepareEpisode(content, NOW);
  insertExperience(store.db, {
    schemaVersion: 1,
    pipelineVersion: 'v1',
    identity: 'agent',
    sessionId: 'session',
    episodeId: 'source',
    contentHash: prepared.contentHash,
    occurredAt: NOW.toISOString(),
    archivedAt: NOW.toISOString(),
    payload: content,
  });
  return {
    sourceId: 'source',
    sessionId: 'session',
    contentHash: prepared.contentHash,
    turns: prepared.turns.map((turn, ordinal) => ({
      turnId: `turn-${ordinal}`,
      ordinal,
      role: turn.role,
      contentHash: turn.contentHash,
    })),
  };
}
function plan(raw: LegacyRawNodes, reverify = false) {
  return planSourceVerification(store.db, {
    sourceId: 'source',
    bounds: archiveRowidBounds(store.db),
    raw,
    now: NOW,
    reverify,
  });
}
const CONTENT: ReflectionContent = { turns: [{ role: 'user', text: 'original text' }] };
it('pins an extra raw turn instead of verifying only the archive-length prefix', () => {
  const raw = seed(CONTENT);
  expect(
    plan({ ...raw, turns: [...raw.turns, { turnId: 'extra', ordinal: 1, contentHash: 'extra' }] })
      .status,
  ).toBe('pinned');
});
it('pins conflicting session ownership', () => {
  const raw = seed(CONTENT);
  expect(plan({ ...raw, sessionId: 'another-session' }).status).toBe('pinned');
});
it('pins a changed role even if the stored content-hash property was not recomputed', () => {
  const raw = seed(CONTENT);
  expect(
    plan({ ...raw, turns: raw.turns.map((turn) => ({ ...turn, role: 'assistant' })) }).status,
  ).toBe('pinned');
});
it('recomputes the archive payload digest rather than trusting its hash column', () => {
  const raw = seed({ observations: ['original observation'] });
  const row = getExperienceByEpisode(store.db, 'source');
  expect(row).toBeDefined();
  store.db
    .prepare('UPDATE experience_archive SET payload_json=? WHERE episode_id=?')
    .run(JSON.stringify({ observations: ['changed observation'] }), 'source');
  expect(plan(raw).status).toBe('pinned');
});
it('does not replace original part identities with a differently named projection during re-verification', () => {
  const raw = seed(CONTENT);
  const before = plan(raw);
  expect(before.status).toBe('verified');
  applySourceVerification(store.db, before);
  expect(
    plan({ ...raw, turns: raw.turns.map((turn) => ({ ...turn, turnId: 'stranger' })) }, true)
      .status,
  ).toBe('pinned');
});
it('verifies the unchanged control', () => {
  const raw = seed(CONTENT);
  expect(plan(raw).status).toBe('verified');
});

it('re-verifies a later occurrence through its existing canonical archive mapping', () => {
  const content: ReflectionContent = { observations: ['same archived bytes'] };
  seedSource(store.db, {
    sourceId: 'first',
    sessionId: 'session',
    identity: 'agent',
    content,
    now: NOW,
  });
  commitSourceState(store.db, {
    sourceId: 'first',
    stateKind: 'forgotten',
    operationId: 'forget-first',
    at: NOW,
  });
  seedSource(store.db, {
    sourceId: 'second',
    sessionId: 'session',
    identity: 'agent',
    content,
    now: NOW,
  });
  expect(getExperienceByEpisode(store.db, 'second')).toBeUndefined();
  const prepared = prepareEpisode(content, NOW);
  expect(
    planSourceVerification(store.db, {
      sourceId: 'second',
      bounds: archiveRowidBounds(store.db),
      raw: {
        sourceId: 'second',
        sessionId: 'session',
        contentHash: prepared.contentHash,
        turns: [],
      },
      now: NOW,
      reverify: true,
    }).status,
  ).toBe('verified');
});
