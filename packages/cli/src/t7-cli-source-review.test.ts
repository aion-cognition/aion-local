import * as core from '@aion/core';
import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { Substrate, type SubstrateCommand } from './substrate.js';
import { runTimelineCommand } from './timeline.js';
import { runWhy } from './why.js';
import { EvidenceResolver } from '../../core/src/evidence/application/resolver.js';
import { seedSource } from '../../core/src/evidence/test-support/evidence.fixture.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../core/src/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../core/src/infrastructure/sqlite/database.js';
import { runSourceInspection } from '../../core/src/introspection/application/source-inspect.js';

const state = vi.hoisted(() => ({
  substrate: undefined as Substrate | undefined,
  errors: [] as string[],
}));
vi.mock('./substrate.js', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    withSubstrate: async (command: SubstrateCommand<unknown>) => {
      if (state.substrate === undefined) {
        throw new Error('test substrate was not installed');
      }
      return command.run(state.substrate, command.parse(command.argv));
    },
  };
});
vi.mock('./output.js', () => ({
  stdoutWriter: () => undefined,
  stderrWriter: (line: string) => state.errors.push(line),
}));

const START = new Date('2026-09-01T10:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');
let dir: string;
let store: SqliteStore;
let logger: ReturnType<typeof core.openLogger>;
const driver = { executeQuery: async () => ({ records: [] }) } as unknown as Driver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-cli-source-review-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: START, fieldPolicyVersion: 1 });
  logger = core.openLogger({ filePath: join(dir, 'log.jsonl'), level: 'error' });
  state.substrate = new Substrate(core.DEFAULTS, 'review', () => undefined);
  state.errors = [];
  vi.spyOn(state.substrate, 'db').mockReturnValue(store.db);
  vi.spyOn(state.substrate, 'connection').mockReturnValue({ driver } as core.GraphConnection);
  vi.spyOn(state.substrate, 'logger').mockReturnValue(logger);
  vi.spyOn(core, 'loadEpisodeContext').mockResolvedValue(undefined);
  vi.spyOn(core, 'fetchNodeProvenance').mockResolvedValue(undefined);
  vi.spyOn(core, 'fetchNodeEdges').mockResolvedValue({ edges: [], complete: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  logger.flush();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('finds an evicted source occurrence through its canonical archive mapping in timeline', async () => {
  const content = {
    turns: [{ role: 'user' as const, text: 'same evidence', occurred_at: START.toISOString() }],
  };
  for (const id of ['original', 'repush']) {
    seedSource(store.db, {
      sourceId: id,
      sessionId: 'session',
      identity: 'same-agent',
      content,
      turnIds: [`${id}-turn`],
      now: NOW,
    });
  }
  expect(core.getExperienceByEpisode(store.db, 'repush')).toBeUndefined();
  const inspected = await runSourceInspection(
    {
      db: store.db,
      resolver: new EvidenceResolver({ db: store.db, driver, logger }),
      now: () => NOW,
    },
    { id: 'repush' },
  );
  expect(inspected.status).toBe('source');
  expect(await runTimelineCommand(['repush'])).toBe(0);
});

it('refuses why before graph reads when the coverage registry is unreadable', async () => {
  store.db.exec('ALTER TABLE coverage_contract RENAME TO coverage_contract_review');
  try {
    expect(await runWhy(['some-id'])).toBe(1);
    expect(core.fetchNodeProvenance).not.toHaveBeenCalled();
  } finally {
    store.db.exec('ALTER TABLE coverage_contract_review RENAME TO coverage_contract');
  }
});
