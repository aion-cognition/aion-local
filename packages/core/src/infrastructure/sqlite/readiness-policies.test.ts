import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  publishReadinessPolicy,
  readCurrentReadinessPolicy,
  readinessContractDigest,
} from './readiness-policies.js';
import { readPolicyStages } from './source-readiness.js';

const NOW = new Date('2026-09-08T02:00:00.000Z');
const LATER = new Date('2026-09-08T03:00:00.000Z');
const CONTRACT = {
  pipelineVersion: 'v1',
  stageNames: ['entities', 'cognitive'],
  transferCapabilities: ['supersession'],
};

describe('readiness policy', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-readiness-policy-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('publishes the first revision and answers with it', () => {
    expect(publishReadinessPolicy(store.db, CONTRACT, NOW)).toBe(1);
    expect(readCurrentReadinessPolicy(store.db)).toEqual({
      policyRevision: 1,
      pipelineVersion: 'v1',
      stageNames: CONTRACT.stageNames,
    });
  });

  it('spends no revision when the same contract is published again', () => {
    publishReadinessPolicy(store.db, CONTRACT, NOW);

    expect(publishReadinessPolicy(store.db, CONTRACT, LATER)).toBe(1);
    expect(store.db.prepare('SELECT count(*) AS n FROM readiness_policies').get()).toEqual({
      n: 1,
    });
  });

  it('takes a new revision when the stage set changes and leaves the old one intact', () => {
    publishReadinessPolicy(store.db, CONTRACT, NOW);

    const next = publishReadinessPolicy(
      store.db,
      { ...CONTRACT, stageNames: [...CONTRACT.stageNames, 'supersession'] },
      LATER,
    );

    expect(next).toBe(2);
    // A source accepted under revision 1 is still measured against the list it accepted.
    expect(readPolicyStages(store.db, 1)).toEqual(['entities', 'cognitive']);
    expect(readPolicyStages(store.db, 2)).toEqual(['entities', 'cognitive', 'supersession']);
  });

  it('takes a new revision when the pipeline version changes', () => {
    publishReadinessPolicy(store.db, CONTRACT, NOW);

    expect(publishReadinessPolicy(store.db, { ...CONTRACT, pipelineVersion: 'v2' }, LATER)).toBe(2);
  });

  it('keys the revision on the contract rather than on the order capabilities are listed in', () => {
    expect(readinessContractDigest(CONTRACT)).toBe(
      readinessContractDigest({ ...CONTRACT, transferCapabilities: ['supersession'] }),
    );
    // Stage order is part of the contract: it is what decides which stage is upstream of which.
    expect(readinessContractDigest(CONTRACT)).not.toBe(
      readinessContractDigest({ ...CONTRACT, stageNames: ['cognitive', 'entities'] }),
    );
  });
});
