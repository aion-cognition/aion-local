import { describe, expect, it } from 'vitest';

import {
  actionableDemand,
  decideOrphan,
  orphanRepairRelevance,
  type OrphanCandidate,
} from './orphan-policy.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const POLICY = { now: NOW, forgetAfterDays: 30 };
const LONG_AGO = new Date('2026-07-01T02:00:00.000Z');
const YESTERDAY = new Date('2026-09-07T02:00:00.000Z');

function candidate(overrides: Partial<OrphanCandidate> = {}): OrphanCandidate {
  return {
    nodeId: 'node-1',
    support: 'unsupported',
    relinkTarget: undefined,
    protectedByPendingWork: false,
    qualifiedSince: LONG_AGO,
    ...overrides,
  };
}

describe('orphan policy', () => {
  it('prefers a relink to a forget, since only one of the two is reversible', () => {
    expect(decideOrphan(candidate({ relinkTarget: 'node-2' }), POLICY)).toMatchObject({
      action: 'relink',
      actionable: true,
    });
  });

  it('never forgets a node the records still hold up', () => {
    expect(decideOrphan(candidate({ support: 'supported' }), POLICY)).toMatchObject({
      action: 'hold',
      reason: 'the records still hold it up',
      actionable: false,
    });
  });

  it('never forgets a node whose support nobody has counted', () => {
    expect(decideOrphan(candidate({ support: 'unknown' }), POLICY)).toMatchObject({
      action: 'hold',
      reason: 'support is uncounted',
      actionable: false,
    });
  });

  it('holds a node a judgment is still pending on', () => {
    expect(decideOrphan(candidate({ protectedByPendingWork: true }), POLICY)).toMatchObject({
      action: 'hold',
      actionable: false,
    });
  });

  it('holds a node with no qualification record, whose age is unknown rather than large', () => {
    expect(decideOrphan(candidate({ qualifiedSince: undefined }), POLICY)).toMatchObject({
      action: 'hold',
      reason: 'no qualification record',
    });
  });

  it('holds a certified node that has not yet been certified for long enough', () => {
    expect(decideOrphan(candidate({ qualifiedSince: YESTERDAY }), POLICY)).toMatchObject({
      action: 'hold',
      reason: 'certified unsupported but not yet mature',
      actionable: false,
    });
  });

  it('forgets a node certified unsupported for the whole window', () => {
    expect(decideOrphan(candidate(), POLICY)).toMatchObject({
      action: 'forget',
      actionable: true,
    });
  });

  it('counts only what a run could act on now', () => {
    const decisions = [
      decideOrphan(candidate({ relinkTarget: 'node-2' }), POLICY),
      decideOrphan(candidate(), POLICY),
      decideOrphan(candidate({ support: 'unknown' }), POLICY),
      decideOrphan(candidate({ qualifiedSince: YESTERDAY }), POLICY),
    ];

    expect(actionableDemand(decisions)).toBe(2);
  });

  it('scores a run on the demand it could fill rather than on the share of the graph', () => {
    expect(orphanRepairRelevance(0, 50)).toBe(0);
    expect(orphanRepairRelevance(25, 50)).toBe(0.5);
    expect(orphanRepairRelevance(500, 50)).toBe(1);
    expect(orphanRepairRelevance(5, 0)).toBe(0);
  });
});
