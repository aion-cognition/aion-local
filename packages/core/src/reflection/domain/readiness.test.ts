import { describe, expect, it } from 'vitest';

import {
  evaluateProcessingReadiness,
  readinessSupportsSampling,
  type RecordedWork,
} from './readiness.js';

const GENERATION = {
  processingGeneration: 1,
  policyRevision: 1,
  inputDigest: 'digest',
  operationalRevision: 4,
};

function stage(name: string, overrides: Partial<RecordedWork> = {}): RecordedWork {
  return {
    workId: `stage:source:1:${name}`,
    kind: 'stage',
    stageName: name,
    workKey: `stage:${name}`,
    state: 'pending',
    reason: null,
    outcome: undefined,
    ...overrides,
  };
}

function settled(name: string, outcome: 'complete' | 'not_applicable' = 'complete'): RecordedWork {
  return stage(name, {
    state: 'completed',
    outcome: { outcome, reason: 'accepted_pass_applied' },
  });
}

describe('processing readiness', () => {
  it('answers unknown when no generation is active', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: undefined,
      requiredStages: ['entities'],
      work: [],
    });

    expect(readiness.completeness).toBe('unknown');
    expect(readiness.reasons).toEqual(['no active processing generation']);
    expect(readinessSupportsSampling(readiness)).toBe(false);
  });

  it('answers unknown when the policy the source was accepted under cannot be read', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: undefined,
      work: [settled('entities')],
    });

    expect(readiness.completeness).toBe('unknown');
    expect(readiness.reasons).toContain('policy revision 1 is not readable');
  });

  it('answers unknown for a required stage with no row rather than counting it as done', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities', 'cognitive'],
      work: [settled('entities')],
    });

    expect(readiness.completeness).toBe('unknown');
    expect(readiness.stages).toContainEqual({
      stageName: 'cognitive',
      disposition: 'unrecorded',
      reason: 'no row for a required stage',
    });
  });

  it('answers unknown while an inventory obligation stands, not merely incomplete', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: [],
      work: [
        {
          workId: 'inventory:pending_policy:source:1',
          kind: 'inventory',
          stageName: null,
          workKey: 'inventory:pending_policy',
          state: 'pending',
          reason: null,
          outcome: undefined,
        },
      ],
    });

    expect(readiness.completeness).toBe('unknown');
  });

  it('reads a completed row with no typed outcome as unrecorded', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities'],
      work: [stage('entities', { state: 'completed' })],
    });

    expect(readiness.completeness).toBe('unknown');
    expect(readiness.stages[0]?.disposition).toBe('unrecorded');
  });

  it('is incomplete while a stage is owed and names the row that owes it', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities', 'cognitive'],
      work: [settled('entities'), stage('cognitive', { state: 'retryable', reason: 'model down' })],
    });

    expect(readiness.completeness).toBe('incomplete');
    expect(readiness.outstandingWorkIds).toEqual(['stage:source:1:cognitive']);
    expect(readiness.stages[1]).toEqual({
      stageName: 'cognitive',
      disposition: 'retryable',
      reason: 'model down',
    });
  });

  it('counts a transferred obligation as outstanding', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities'],
      work: [stage('entities', { state: 'transferred', reason: 'supersession' })],
    });

    expect(readiness.completeness).toBe('incomplete');
    expect(readinessSupportsSampling(readiness)).toBe(false);
  });

  it('treats a dead letter as unresolved work rather than a completion', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities'],
      work: [stage('entities', { state: 'dead_letter', reason: 'gave up' })],
    });

    expect(readiness.completeness).toBe('incomplete');
    expect(readiness.stages[0]?.disposition).toBe('retryable');
  });

  it('is complete when every required stage carries a typed outcome and nothing else is owed', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities', 'supersession'],
      work: [settled('entities'), settled('supersession', 'not_applicable')],
    });

    expect(readiness.completeness).toBe('complete');
    expect(readiness.operationalRevision).toBe(4);
    expect(readinessSupportsSampling(readiness)).toBe(true);
  });

  it('stays incomplete while a non-stage obligation is outstanding', () => {
    const readiness = evaluateProcessingReadiness({
      sourceId: 'source',
      generation: GENERATION,
      requiredStages: ['entities'],
      work: [
        settled('entities'),
        {
          workId: 'index:source:1',
          kind: 'index',
          stageName: null,
          workKey: 'source_index',
          state: 'pending',
          reason: null,
          outcome: undefined,
        },
      ],
    });

    expect(readiness.completeness).toBe('incomplete');
    expect(readinessSupportsSampling(readiness)).toBe(false);
  });
});
