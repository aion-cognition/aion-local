import type { Driver } from 'neo4j-driver';
import pino from 'pino';
import { expect, it, vi } from 'vitest';

import { recallProbeOperation } from './operations/recall-probe.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  allocateProcessingGeneration,
  activateProcessingGeneration,
  prepareInventorySkeleton,
  completeSourceWork,
  stageWorkId,
} from '../../infrastructure/sqlite/processing-generations.js';
import { publishReadinessPolicy } from '../../infrastructure/sqlite/readiness-policies.js';
import { processingReadinessOf } from '../../reflection/application/readiness.js';
import { readinessSupportsSampling } from '../../reflection/domain/readiness.js';
import { healthFixture } from '../domain/test-support/health.fixture.js';

const OLD = new Date('2026-09-01T00:00:00.000Z');
const NOW = new Date('2026-09-08T00:00:00.000Z');

it.each(['empty', 'partial', 'dead_letter', 'complete'] as const)(
  'samples only the accepted complete inventory: %s',
  async (mode) => {
    const store = new SqliteStore({ filePath: ':memory:' });
    try {
      prepareCoverageContract(store.db, 1);
      activateCoverageContract(store.db, { activatedAt: OLD, fieldPolicyVersion: 1 });
      seedSource(store.db, {
        sourceId: 'source',
        sessionId: 'session',
        identity: 'review',
        now: OLD,
        content: { observations: ['the ledger uses sqlite'] },
      });
      const policy = publishReadinessPolicy(
        store.db,
        { pipelineVersion: 'fixture', stageNames: ['one', 'two'], transferCapabilities: [] },
        OLD,
      );
      const generation = allocateProcessingGeneration(store.db, {
        sourceId: 'source',
        policyRevision: policy,
        inputDigest: 'fixture-input',
        createdAt: OLD,
      });
      const stagesByMode = {
        empty: [],
        partial: ['one'],
        dead_letter: ['one', 'two'],
        complete: ['one', 'two'],
      } as const;
      const stages = stagesByMode[mode];
      prepareInventorySkeleton(store.db, {
        sourceId: 'source',
        processingGeneration: generation,
        stageNames: stages,
        dueAt: OLD,
      });
      activateProcessingGeneration(store.db, 'source', generation);
      for (const stage of stages) {
        completeSourceWork(
          store.db,
          stageWorkId('source', generation, stage),
          { outcome: 'complete', reason: 'accepted_pass_applied' },
          OLD,
        );
      }
      if (mode === 'dead_letter') {
        store.db
          .prepare(
            `INSERT INTO source_work(work_id,source_id,processing_generation,kind,work_key,state,due_at)
        VALUES ('owed','source',?,'judgment','pending-pair','dead_letter',?)`,
          )
          .run(generation, OLD.toISOString());
      }
      expect(readinessSupportsSampling(processingReadinessOf(store.db, 'source'))).toBe(
        mode === 'complete',
      );
      const recall = vi.fn(async () => {
        throw new Error('scripted recall endpoint reached');
      });
      await recallProbeOperation().run({
        driver: { executeQuery: async () => ({ records: [] }) } as unknown as Driver,
        db: store.db,
        now: NOW,
        signal: new AbortController().signal,
        config: {
          ...DEFAULTS,
          maintenance: { ...DEFAULTS.maintenance, recallProbe: true, recallProbeSample: 1 },
        },
        logger: pino({ enabled: false }),
        health: healthFixture(),
        recallProbe: recall,
        provider: { embed: async () => [], generate: async () => ({}) },
      });
      expect(recall).toHaveBeenCalledTimes(mode === 'complete' ? 1 : 0);
    } finally {
      store.close();
    }
  },
);
