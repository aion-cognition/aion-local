import { afterEach, beforeEach, expect, it } from 'vitest';

import { calendarRollupPublication } from './calendar-rollup-publication.js';
import { GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type {
  PublicationAckContext,
  PublicationPlan,
} from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { readScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';

/**
 * The rollup's node-state mirror, which its two siblings have advanced since they shipped.
 *
 * A rollup supersedes the narratives it absorbs and closes their edges, which is a change to each
 * one's own semantic state. Whoever is holding evidence about that state has to stop being able to
 * verify it as current, and the only place that can happen is the operation that made the change.
 */

const NOW = '2026-09-12T09:00:00.000Z';
const HEAD = 'narrative-day-head';

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

function context(operationId: string): PublicationAckContext {
  return {
    operationId,
    sequence: '1',
    db: store.db,
    knownFrom: NOW,
    observedAckAt: NOW,
    clockClamped: false,
  };
}

/** A plan that absorbs the named narratives into the head, with nothing else to write. */
function plan(closes: readonly string[]): PublicationPlan {
  return {
    data: {
      mode: 'repair',
      scope: 'day',
      windowKey: '2026-09-11',
      nodeId: HEAD,
      version: 1,
      coverageKey: 'coverage-1',
      memberIds: [],
      closes: [...closes],
      summary: '',
      narrative: '',
      citations: [],
      sentenceCount: 0,
      spanStart: null,
      spanEnd: null,
      occurredAt: NOW,
      windowStart: NOW,
      windowEnd: NOW,
      memberScope: 'session',
      expectedHeads: [],
      openCloses: [...closes],
      coverageEpoch: 'epoch-1',
      ownedIds: [...closes],
      dependencies: [],
      observedAt: NOW,
      closedCoverage: [],
      closedMembership: [],
      closureBounded: false,
    },
    expected: {
      coverageEpoch: 'epoch-1',
      evidence: buildEvidenceRevision([]),
      sources: [],
      heads: [],
    },
    scopes: [],
    effects: [],
  };
}

const RESULT = { nodeId: HEAD, created: false, absorbed: 1, retiredCoverage: 0 };

function mirrorOf(nodeId: string): number | undefined {
  return readScopeMirror(store.db, { endpointId: nodeId, relationClass: GRAPH_NODE_SCOPE })
    ?.mirroredRevision;
}

it('advances the node-state mirror of every narrative it absorbs', () => {
  calendarRollupPublication.acknowledgeSqlite(
    context('rollup-1'),
    plan(['narrative-a', 'narrative-b']),
    RESULT,
  );

  expect(mirrorOf('narrative-a')).toBe(1);
  expect(mirrorOf('narrative-b')).toBe(1);
});

it('leaves the head it publishes into alone, because nothing superseded it', () => {
  calendarRollupPublication.acknowledgeSqlite(
    context('rollup-1'),
    plan([HEAD, 'narrative-a']),
    RESULT,
  );

  expect(mirrorOf(HEAD)).toBeUndefined();
  expect(mirrorOf('narrative-a')).toBe(1);
});

it('carries the revision forward rather than restarting it, on a second close', () => {
  calendarRollupPublication.acknowledgeSqlite(context('rollup-1'), plan(['narrative-a']), RESULT);
  calendarRollupPublication.acknowledgeSqlite(context('rollup-2'), plan(['narrative-a']), RESULT);

  expect(mirrorOf('narrative-a')).toBe(2);
  expect(
    readScopeMirror(store.db, { endpointId: 'narrative-a', relationClass: GRAPH_NODE_SCOPE })
      ?.operationId,
  ).toBe('rollup-2');
});

it('records nothing when a repair closes nothing at all', () => {
  calendarRollupPublication.acknowledgeSqlite(context('rollup-1'), plan([]), RESULT);

  expect(mirrorOf(HEAD)).toBeUndefined();
});
