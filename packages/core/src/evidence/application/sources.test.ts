import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSourceEvidence, type SourceReadRequest } from './sources.js';
import { asOf, knewAt } from '../../infrastructure/graph/read-modes.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { idAddress, partAddress } from '../domain/address.js';
import { EVIDENCE_LIMITS, RequestBudget } from '../domain/budget.js';
import { checkedContext, commitSourceState, seedSource } from '../test-support/evidence.fixture.js';

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

  it('rebuilds the whole source in the order it was captured', () => {
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request());

    expect(resolution.residency).toBe('resident');
    expect(resolution.issues).toEqual([]);
    expect(resolution.value?.text).toContain('the migration took 45 seconds');
    expect(resolution.value?.text).toContain('observation: the runbook was out of date');
    expect(resolution.value?.text).toContain('tool psql [ok]');
    expect(resolution.value?.parts.map((part) => part.partKind)).toEqual([
      'observation',
      'tool_execution',
      'turn',
      'turn',
    ]);
  });

  it('measures both size units from the verified text', () => {
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request());
    const text = resolution.value?.text ?? '';

    expect(resolution.value?.rawUtf16CodeUnits).toBe(text.length);
    expect(resolution.value?.decodedRawUtf8Bytes).toBe(Buffer.byteLength(text, 'utf8'));
  });

  it('resolves one part by its tuple and the same part by its original turn id', () => {
    const byTuple = resolveSourceEvidence(store.db, partAddress('episode-1', 'turn', 1), request());
    const byTurnId = resolveSourceEvidence(store.db, idAddress('turn-b'), request());

    expect(byTuple.value?.parts).toHaveLength(1);
    expect(byTuple.value?.text).toBe('assistant: recorded, 45 seconds');
    expect(byTurnId.value?.text).toBe(byTuple.value?.text);
    expect(byTurnId.value?.parts[0]?.turnId).toBe('turn-b');
  });

  it('answers an id nothing accounts for as an unknown mapping', () => {
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-404'), request());

    expect(resolution.residency).toBe('unknown-mapping');
    expect(resolution.issues.map((issue) => issue.reason)).toEqual(['unresolved_mapping']);
    expect(resolution.value).toBeUndefined();
  });

  it('answers a part ordinal the source never had as certified absence', () => {
    const resolution = resolveSourceEvidence(
      store.db,
      partAddress('episode-1', 'turn', 9),
      request(),
    );

    expect(resolution.issues.map((issue) => issue.reason)).toEqual(['not_found']);
  });

  it('names each residency phase and keeps the content complete through all of them', () => {
    for (const state of ['retiring', 'evicted'] as const) {
      transitionSourceResidency(store.db, {
        sourceId: 'episode-1',
        state,
        operationId: `move-${state}`,
        transitionedAt: LATER,
      });
      const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request());

      expect(resolution.residency).toBe(state);
      expect(resolution.issues).toEqual([]);
      expect(resolution.value?.text).toContain('the migration took 45 seconds');
    }
  });

  it('withholds a suppressed source as an eligibility outcome rather than a gap', () => {
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: LATER,
    });
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request());

    expect(resolution.issues.map((issue) => issue.reason)).toEqual(['suppressed_source']);
    expect(resolution.issues[0]?.field).toBe('eligibility');
    expect(resolution.value).toBeUndefined();
  });

  it('lets indexing read a suppressed source that every named purpose still withholds', () => {
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: LATER,
    });

    expect(
      resolveSourceEvidence(store.db, idAddress('episode-1'), request({ use: 'search_indexing' }))
        .value?.text,
    ).toContain('the migration took 45 seconds');
    expect(
      resolveSourceEvidence(store.db, idAddress('episode-1'), request({ use: 'claim_judgment' }))
        .value,
    ).toBeUndefined();
  });

  it('reads suppression at the moment the request is judged against', () => {
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: LATER,
    });
    const before = resolveSourceEvidence(
      store.db,
      idAddress('episode-1'),
      request({ context: checkedContext({ mode: knewAt(NOW) }) }),
    );

    expect(before.issues).toEqual([]);
    expect(before.value?.text).toContain('the migration took 45 seconds');
  });

  it('unsuppresses on the newer statement of the same chain', () => {
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: NOW,
    });
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'unforgotten',
      operationId: 'unforget-1',
      at: LATER,
    });

    expect(resolveSourceEvidence(store.db, idAddress('episode-1'), request()).issues).toEqual([]);
  });

  it('reports an archive row that no longer hashes to its record as an unknown mapping', () => {
    store.db
      .prepare("UPDATE experience_archive SET payload_json = ? WHERE episode_id = 'episode-1'")
      .run(JSON.stringify({ ...CONTENT, summary: 'a different conversation' }));
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request());

    expect(resolution.issues.map((issue) => issue.reason)).toEqual(['unresolved_mapping']);
    expect(resolution.value).toBeUndefined();
  });

  it('names a payload past the byte allowance instead of dropping it from the answer', () => {
    const budget = new RequestBudget({ ...EVIDENCE_LIMITS, decodedRawBytes: 16 });
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request({ budget }));

    expect(resolution.issues.map((issue) => issue.reason)).toEqual(['budget_limit']);
    expect(resolution.value).toBeUndefined();
  });

  it('names the clock gap on a rebuilt projection without withholding its content', () => {
    transitionSourceResidency(store.db, {
      sourceId: 'episode-1',
      state: 'resident',
      operationId: 'rebuild-1',
      transitionedAt: LATER,
      rebuildAckAt: LATER,
    });
    const resolution = resolveSourceEvidence(
      store.db,
      idAddress('episode-1'),
      request({ context: checkedContext({ mode: asOf(NOW) }) }),
    );

    expect(resolution.issues).toMatchObject([
      { reason: 'unsupported_history', historyReason: 'not_recorded', required: false },
    ]);
    expect(resolution.value?.text).toContain('the migration took 45 seconds');
  });

  it('cites the four source scopes it read under', () => {
    const resolution = resolveSourceEvidence(store.db, idAddress('episode-1'), request());

    expect(resolution.dependencies.map((dependency) => dependency.scope)).toEqual([
      'source.content',
      'source.parts',
      'source.state',
      'source.references',
    ]);
  });
});
