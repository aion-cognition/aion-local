import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sourceScopeDependencies, verifyEvidenceRevision } from './dependencies.js';
import { resolveSourceEvidence, type SourceReadRequest } from './sources.js';
import { asOf, knewAt } from '../../infrastructure/graph/read-modes.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { idAddress } from '../domain/address.js';
import { RequestBudget } from '../domain/budget.js';
import { checkedContext, seedSource } from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');
const LATER = new Date('2026-09-08T14:00:00.000Z');

const CONTENT: ReflectionContent = {
  summary: 'the deploy conversation',
  turns: [
    { role: 'user', text: 'the migration took 45 seconds', occurred_at: NOW.toISOString() },
    { role: 'assistant', text: 'recorded, 45 seconds', occurred_at: NOW.toISOString() },
  ],
  observations: ['the runbook was out of date'],
  tool_executions: [{ tool: 'psql', status: 'ok', output: 'ALTER TABLE' }],
};

function request(overrides: Partial<SourceReadRequest> = {}): SourceReadRequest {
  return {
    use: 'raw_inspection',
    context: checkedContext(),
    budget: new RequestBudget(),
    required: true,
    ...overrides,
  };
}

describe('raw source evidence', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-evidence-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    seedSource(store.db, {
      sourceId: 'episode-1',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: CONTENT,
      turnIds: ['turn-a', 'turn-b'],
      now: NOW,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not certify a whole source with a missing recorded part', () => {
    store.db
      .prepare(
        "DELETE FROM source_parts WHERE source_id='episode-1' AND part_kind='turn' AND ordinal=1",
      )
      .run();
    const result = resolveSourceEvidence(store.db, idAddress('episode-1'), request());
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it('checks the recorded role against the captured role', () => {
    store.db
      .prepare(
        "UPDATE source_parts SET role='assistant' WHERE source_id='episode-1' AND part_kind='turn' AND ordinal=0",
      )
      .run();
    const result = resolveSourceEvidence(store.db, idAddress('episode-1'), request());
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it('checks the recorded occurrence against the captured occurrence', () => {
    store.db
      .prepare(
        "UPDATE source_parts SET occurred_at=? WHERE source_id='episode-1' AND part_kind='turn' AND ordinal=0",
      )
      .run(LATER.toISOString());
    const result = resolveSourceEvidence(store.db, idAddress('episode-1'), request());
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it('invalidates a revision when an original turn mapping changes', () => {
    const revision = buildEvidenceRevision(sourceScopeDependencies(store.db, 'episode-1'));
    store.db
      .prepare(
        "UPDATE source_parts SET turn_id='changed-turn' WHERE source_id='episode-1' AND part_kind='turn' AND ordinal=0",
      )
      .run();
    expect(verifyEvidenceRevision(store.db, revision).status).not.toBe('current');
  });
  it('invalidates a revision when its mapping loses verification', () => {
    const revision = buildEvidenceRevision(sourceScopeDependencies(store.db, 'episode-1'));
    store.db
      .prepare(
        "UPDATE source_records SET verification_status='pinned', verification_reason='proof lost' WHERE source_id='episode-1'",
      )
      .run();
    expect(verifyEvidenceRevision(store.db, revision).status).not.toBe('current');
  });
  it('does not certify content before the first proved source availability', () => {
    const result = resolveSourceEvidence(
      store.db,
      idAddress('episode-1'),
      request({
        context: checkedContext({ mode: knewAt(new Date('2026-09-08T09:00:00.000Z')), now: LATER }),
      }),
    );
    expect(result.issues.length).toBeGreaterThan(0);
  });
  it('does not invent a missing logical clock merely because the projection was rebuilt', () => {
    transitionSourceResidency(store.db, {
      sourceId: 'episode-1',
      state: 'resident',
      operationId: 'rebuilt',
      transitionedAt: LATER,
      rebuildAckAt: LATER,
    });
    const result = resolveSourceEvidence(
      store.db,
      idAddress('episode-1'),
      request({ context: checkedContext({ mode: asOf(NOW), now: LATER }) }),
    );
    expect(result.value?.occurredAt).toBe(NOW.toISOString());
    expect(result.issues.filter((issue) => issue.reason === 'unsupported_history')).toEqual([]);
  });
});
