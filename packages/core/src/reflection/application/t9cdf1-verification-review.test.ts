import { afterEach, beforeEach, expect, it } from 'vitest';

import { applySourceVerification, planSourceVerification } from './legacy-verification.js';
import { commitSourceState } from '../../evidence/test-support/evidence.fixture.js';
import type { LegacyRawNodes } from '../../infrastructure/graph/legacy-evidence-queries.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { insertExperience } from '../../infrastructure/sqlite/experience-archive.js';
import { archiveRowidBounds } from '../../infrastructure/sqlite/legacy-archive-scan.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { isSourceForgotten } from '../../infrastructure/sqlite/source-lifecycle.js';
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

it('checks each recorded turn ordinal rather than its position in the returned array', () => {
  const raw = seed(CONTENT);
  expect(plan({ ...raw, turns: raw.turns.map((turn) => ({ ...turn, ordinal: 7 })) }).status).toBe(
    'pinned',
  );
});
it('does not overwrite a newer acknowledged unforget with an older graph forget', () => {
  const raw = seed(CONTENT);
  applySourceVerification(store.db, plan(raw));
  commitSourceState(store.db, {
    sourceId: 'source',
    stateKind: 'forgotten',
    operationId: 'old-forget',
    at: NOW,
  });
  commitSourceState(store.db, {
    sourceId: 'source',
    stateKind: 'unforgotten',
    operationId: 'new-unforget',
    at: new Date(NOW.getTime() + 1000),
  });
  const stale = { ...plan(raw, true), forgottenAt: NOW.toISOString() };
  preparePublicationIntent(store.db, {
    operationId: 'legacy-pass',
    kind: 'legacy_materialization',
    payloadDigest: 'legacy',
    payloadJson: '{}',
    affectedScopesJson: '[]',
    expectedJson: '{}',
    preparedActionsJson: '[]',
    createdAt: NOW,
  });
  applySourceVerification(store.db, stale, {
    operationId: 'legacy-pass',
    knownFrom: new Date(NOW.getTime() + 2000),
  });
  acknowledgePublicationIntent(store.db, {
    operationId: 'legacy-pass',
    resultDigest: 'legacy',
    resultJson: '{}',
    observedAckAt: new Date(NOW.getTime() + 2000),
  });
  expect.soft(isSourceForgotten(store.db, 'source')).toBe(false);
  const states = store.db
    .prepare(
      "SELECT state_kind FROM source_state_versions WHERE source_id='source' ORDER BY version",
    )
    .all();
  expect(states).toEqual([{ state_kind: 'forgotten' }, { state_kind: 'unforgotten' }]);
});
