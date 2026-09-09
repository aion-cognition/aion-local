import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  relatedIncidenceNodes,
  sampleSourcesAcceptedBefore,
  servedReferenceOutcome,
} from './probe-incidence.js';
import { transitionSourceResidency } from './source-lifecycle.js';
import { commitIncidence, seedSource } from '../../evidence/test-support/evidence.fixture.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';

const ACCEPTED = new Date('2026-09-06T10:00:00.000Z');
const LATER = new Date('2026-09-08T10:00:00.000Z');

const CONTENT: ReflectionContent = {
  summary: 'the deploy conversation',
  turns: [{ role: 'user', text: 'the migration took 45 seconds' }],
  observations: ['the runbook was out of date'],
};

describe('probe reads over the records', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-probe-incidence-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    seedSource(store.db, {
      sourceId: 'source-1',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: CONTENT,
      turnIds: ['turn-a'],
      now: ACCEPTED,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('samples on acceptance, and keeps an evicted source in the denominator', () => {
    transitionSourceResidency(store.db, {
      sourceId: 'source-1',
      state: 'evicted',
      operationId: 'evict-1',
      transitionedAt: LATER,
    });
    const sampled = sampleSourcesAcceptedBefore(store.db, LATER.toISOString(), 10);

    expect(sampled.map((row) => row.sourceId)).toEqual(['source-1']);
    expect(sampled[0]?.acceptedAt).toBe(ACCEPTED.toISOString());
  });

  it('excludes a source accepted after the cut', () => {
    expect(sampleSourcesAcceptedBefore(store.db, ACCEPTED.toISOString(), 10)).toEqual([]);
  });

  it('names the emitted items the records say the source stands behind', () => {
    commitIncidence(store.db, {
      sourceId: 'source-1',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'extract-1',
      at: ACCEPTED,
    });

    expect(relatedIncidenceNodes(store.db, 'source-1', ['claim-1', 'claim-2'])).toEqual([
      'claim-1',
    ]);
    expect(relatedIncidenceNodes(store.db, 'source-1', ['claim-2'])).toEqual([]);
    expect(relatedIncidenceNodes(store.db, 'source-1', [])).toEqual([]);
  });

  describe('served-then-referenced', () => {
    it('credits an incidence acknowledged after the serve', () => {
      commitIncidence(store.db, {
        sourceId: 'source-1',
        nodeId: 'claim-1',
        role: 'mention',
        operationId: 'mention-1',
        at: LATER,
      });

      expect(servedReferenceOutcome(store.db, 'claim-1', ACCEPTED.toISOString())).toBe(
        'referenced_after',
      );
    });

    it('does not credit an incidence that predates the serve', () => {
      commitIncidence(store.db, {
        sourceId: 'source-1',
        nodeId: 'claim-1',
        role: 'mention',
        operationId: 'mention-1',
        at: ACCEPTED,
      });

      expect(servedReferenceOutcome(store.db, 'claim-1', LATER.toISOString())).toBe('none');
    });

    it('reports an undatable incidence as unknown rather than as a later reference', () => {
      commitIncidence(store.db, {
        sourceId: 'source-1',
        nodeId: 'claim-1',
        role: 'mention',
        operationId: 'mention-1',
        at: LATER,
      });
      // What a backfill leaves behind: the edge is on file and nothing says when it was known.
      store.db.prepare('UPDATE evidence_link_versions SET known_from = NULL').run();

      expect(servedReferenceOutcome(store.db, 'claim-1', ACCEPTED.toISOString())).toBe(
        'unversioned',
      );
    });

    it('reports an item nothing points at as a measured absence', () => {
      expect(servedReferenceOutcome(store.db, 'claim-9', ACCEPTED.toISOString())).toBe('none');
    });
  });
});
