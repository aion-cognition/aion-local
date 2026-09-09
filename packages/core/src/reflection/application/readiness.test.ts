import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processingReadinessOf } from './readiness.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  activateProcessingGeneration,
  allocateProcessingGeneration,
  completeSourceWork,
  prepareInventorySkeleton,
  stageWorkId,
} from '../../infrastructure/sqlite/processing-generations.js';
import { publishReadinessPolicy } from '../../infrastructure/sqlite/readiness-policies.js';
import type { ReflectionContent } from '../domain/content.js';
import { readinessSupportsSampling } from '../domain/readiness.js';

/**
 * One source's readiness read off the records, which is the answer every consumer that asks
 * whether a pass finished has to use. The point of reading it here rather than counting rows is
 * the stage set: it comes from the policy the source was accepted under, so a stage with no row
 * is unaccountable rather than absent.
 */

const ACCEPTED = new Date('2026-09-06T10:00:00.000Z');

const CONTENT: ReflectionContent = {
  summary: 'the deploy conversation',
  turns: [{ role: 'user', text: 'the migration took 45 seconds' }],
  observations: ['the runbook was out of date'],
};

describe('processing readiness over the records', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-readiness-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function accept(sourceId: string): void {
    seedSource(store.db, {
      sourceId,
      sessionId: 'session-1',
      identity: 'agent-1',
      content: CONTENT,
      turnIds: ['turn-a'],
      now: ACCEPTED,
    });
  }

  it('answers unknown for a generation the acknowledgment never activated', () => {
    // A prepared acceptance allocates its generation and stops; activation is the
    // acknowledgment's. Reading an allocated generation as an active one would score a source
    // whose acceptance never landed.
    accept('source-1');
    const readiness = processingReadinessOf(store.db, 'source-1');

    expect(readiness.processingGeneration).toBeUndefined();
    expect(readiness.completeness).toBe('unknown');
    expect(readinessSupportsSampling(readiness)).toBe(false);
  });

  it('reads the generation the acknowledgment activated and still owes its inventory', () => {
    accept('source-1');
    activateProcessingGeneration(store.db, 'source-1', 1);
    const readiness = processingReadinessOf(store.db, 'source-1');

    expect(readiness.processingGeneration).toBe(1);
    // The acceptance records an inventory obligation while no readiness policy exists, and an
    // obligation nobody could write an inventory for makes the answer unknown rather than owed.
    expect(readiness.completeness).toBe('unknown');
    expect(readinessSupportsSampling(readiness)).toBe(false);
  });

  it('answers unknown for a source nothing has processed', () => {
    const readiness = processingReadinessOf(store.db, 'nobody');

    expect(readiness.processingGeneration).toBeUndefined();
    expect(readiness.reasons).toEqual(['no active processing generation']);
    expect(readinessSupportsSampling(readiness)).toBe(false);
  });

  it('supports sampling only once every stage the accepted policy required is settled', () => {
    const policy = publishReadinessPolicy(
      store.db,
      { pipelineVersion: 'fixture', stageNames: ['one', 'two'], transferCapabilities: [] },
      ACCEPTED,
    );
    accept('source-2');
    // The seeded acceptance predates the policy, so it owes an inventory nobody could write. A
    // generation carrying the policy replaces it, which is what a source reprocessed under a
    // published contract gets.
    const generation = allocateProcessingGeneration(store.db, {
      sourceId: 'source-2',
      policyRevision: policy,
      inputDigest: 'fixture-input',
      createdAt: ACCEPTED,
    });
    prepareInventorySkeleton(store.db, {
      sourceId: 'source-2',
      processingGeneration: generation,
      stageNames: ['one', 'two'],
      dueAt: ACCEPTED,
    });
    activateProcessingGeneration(store.db, 'source-2', generation);

    completeSourceWork(
      store.db,
      stageWorkId('source-2', generation, 'one'),
      { outcome: 'complete', reason: 'accepted_pass_applied' },
      ACCEPTED,
    );
    expect(readinessSupportsSampling(processingReadinessOf(store.db, 'source-2'))).toBe(false);

    completeSourceWork(
      store.db,
      stageWorkId('source-2', generation, 'two'),
      { outcome: 'complete', reason: 'accepted_pass_applied' },
      ACCEPTED,
    );
    expect(readinessSupportsSampling(processingReadinessOf(store.db, 'source-2'))).toBe(true);
  });
});
