import * as core from '@aion/core';
import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { Substrate, type SubstrateCommand } from './substrate.js';
import { runTimelineCommand } from './timeline.js';
import { seedSource } from '../../core/src/evidence/test-support/evidence.fixture.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../core/src/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../core/src/infrastructure/sqlite/database.js';

const state = vi.hoisted(() => ({
  substrate: undefined as Substrate | undefined,
  errors: [] as string[],
  output: [] as string[],
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
  state.substrate = new Substrate(core.DEFAULTS, 'review', (line) => state.output.push(line));
  state.errors = [];
  state.output = [];
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

it('dates a repushed archive-backed occurrence from its own source record', async () => {
  const content = {
    turns: [{ role: 'user' as const, text: 'same evidence without a claimed time' }],
  };
  for (const [id, now] of [
    ['original', START],
    ['repush', NOW],
  ] as const) {
    seedSource(store.db, {
      sourceId: id,
      sessionId: 'session',
      identity: 'same-agent',
      content,
      turnIds: [`${id}-turn`],
      now,
    });
  }
  const original = core.readSourceRecord(store.db, 'original');
  const repush = core.readSourceRecord(store.db, 'repush');
  expect(repush?.canonicalArchiveId).toBe(original?.canonicalArchiveId);
  expect(repush?.occurredAt).toBe(NOW.toISOString());
  expect(await runTimelineCommand(['repush', '--json'])).toBe(0);
  const result = JSON.parse(state.output.join('')) as {
    events: { kind: string; at: string }[];
  };
  expect(result.events.find((event) => event.kind === 'occurred')?.at).toBe(NOW.toISOString());
});
