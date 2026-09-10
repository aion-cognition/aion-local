import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { rollUpNarratives } from './narrative-rollup.js';
import type * as RollupWriter from './rollup-write.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { refusingProvider } from '../../infrastructure/providers/test-support/refusing-provider.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

const seam = vi.hoisted(() => ({ members: vi.fn(), synthesize: vi.fn(), write: vi.fn() }));
vi.mock('../../infrastructure/graph/narrative-rollup-queries.js', () => ({
  findRollupMembers: seam.members,
  findWindowRollups: async () => [],
}));
vi.mock('./consolidation-synthesis.js', () => ({ synthesizeGrounded: seam.synthesize }));
vi.mock('./rollup-write.js', async (original) => ({
  ...(await original<typeof RollupWriter>()),
  writeRollup: seam.write,
  closeInto: async () => 0,
  attachVector: async () => undefined,
}));
let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  vi.resetAllMocks();
  seam.synthesize.mockResolvedValue({
    status: 'grounded',
    grounded: {
      summary: 'supported',
      narrative: 'supported',
      citations: ['fitting'],
      kept: 1,
    },
  });
  seam.write.mockResolvedValue(undefined);
});
afterEach(() => {
  store.close();
});

async function run(): Promise<void> {
  await rollUpNarratives(
    {
      driver: {} as Driver,
      db: store.db,
      provider: refusingProvider,
      logger: openLogger({ filePath: '/dev/null', level: 'fatal' }),
    },
    {
      scope: 'day',
      now: new Date('2026-04-06T00:00:00Z'),
      windowLimit: 2,
      renderedInputAllowance: 100,
    },
  );
}

it('eventually reaches a fitting window behind an unchanged blocked prefix', async () => {
  seam.members.mockResolvedValue([
    { id: 'blocked-1', text: 'x'.repeat(300), occurredAt: new Date('2026-04-01T10:00:00Z') },
    { id: 'blocked-2', text: 'x'.repeat(300), occurredAt: new Date('2026-04-02T10:00:00Z') },
    { id: 'fitting', text: 'fits', occurredAt: new Date('2026-04-03T10:00:00Z') },
  ]);
  await run();
  await run();
  await run();
  expect(seam.synthesize).toHaveBeenCalled();
  expect(seam.write.mock.calls.some((call) => call[1]?.windowKey === '2026-04-03')).toBe(true);
});

it('control: the same fitting window can publish without the blocked prefix', async () => {
  seam.members.mockResolvedValue([
    { id: 'fitting', text: 'fits', occurredAt: new Date('2026-04-03T10:00:00Z') },
  ]);
  await run();
  expect(seam.synthesize).toHaveBeenCalledOnce();
  expect(seam.write.mock.calls[0]?.[1].windowKey).toBe('2026-04-03');
});
