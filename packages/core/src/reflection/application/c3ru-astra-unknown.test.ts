import type { Driver } from 'neo4j-driver';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  bindRollupCoverage,
  proveRollupFamily,
  ROLLUP_FAMILY_SCAN_LIMIT,
} from './rollup-family-fence.js';
import type { NarrativeRepresentation } from '../../evidence/application/narrative-representation.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { prepareCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore, type SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * What the fence answers, and which answer wins when a window earns more than one.
 *
 * The refusals below are the whole vocabulary: an unreadable coverage record, an ancestry larger
 * than the proof bound, a member whose session chose chunks, a member belonging to a family that
 * publishes through its own manifest, and every answer the adapter could not prove. The adapter is
 * stood in for here so the branches can be named one at a time; what it actually says about a real
 * cutover, and how a genuinely uninitialized session becomes publishable, are proved against a
 * real substrate.
 */

const seam = vi.hoisted(() => ({ lineage: vi.fn(), read: vi.fn() }));
vi.mock('../../infrastructure/graph/narrative-rollup-queries.js', () => ({
  findRollupLineage: seam.lineage,
}));
vi.mock('../../evidence/application/narrative-representation.js', () => ({
  readNarrativeRepresentations: seam.read,
}));

let store: SqliteStore;

const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });

function representation(overrides: Partial<NarrativeRepresentation> = {}): NarrativeRepresentation {
  return {
    family: 'legacy_session_overview',
    sessions: ['session-1'],
    selection: 'selected',
    publication: 'established',
    ...overrides,
  };
}

function reads(values: Record<string, NarrativeRepresentation>): void {
  seam.read.mockResolvedValue({
    values: new Map(Object.entries(values)),
    dependencies: [],
    issues: [],
  });
}

async function fenceWith(
  deps: { readonly db?: SqliteHandle },
  memberIds: readonly string[],
): Promise<string | undefined> {
  const held = await proveRollupFamily(
    { driver: {} as Driver, ...deps, logger },
    {
      scope: 'day',
      windowKey: '2026-04-02',
      memberIds,
      headIds: [],
      coverage: {
        epoch: 'epoch-under-test',
        context: {
          mode: {},
          now: new Date('2026-04-06T00:00:00Z'),
          coverageEpoch: 'epoch-under-test',
          contractVersion: 1,
          fieldPolicyVersion: 1,
          coverageState: 'preparing',
        },
      },
      now: new Date('2026-04-06T00:00:00Z'),
    },
  );
  return held.status === 'refused' ? held.reason : undefined;
}

function fence(memberIds: readonly string[]): Promise<string | undefined> {
  return fenceWith({ db: store.db }, memberIds);
}

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  vi.resetAllMocks();
  seam.lineage.mockImplementation((_driver: Driver, ids: readonly string[]) =>
    Promise.resolve(ids.map((id) => ({ id, ancestors: [], bounded: false }))),
  );
  reads({});
});

afterEach(() => {
  store.close();
});

it('refuses a window it has no store to prove the family against', async () => {
  expect(await fenceWith({}, ['member-1'])).toBe('family_fence_unavailable');
});

it('takes no binding from a substrate that cannot say what it covers', async () => {
  // The binding moved ahead of the member read, so this is where the same refusal lives now: a
  // pass with no readable contract never reaches a proof, and never reaches the adapter.
  expect(bindRollupCoverage(store.db, new Date('2026-04-06T00:00:00Z'))).toBeUndefined();
  expect(seam.read).not.toHaveBeenCalled();
});

it('refuses a member with no recorded preference and no session to initialize', async () => {
  prepareCoverageContract(store.db, 1);
  reads({ 'member-1': representation({ sessions: [], selection: 'unknown' }) });

  expect(await fence(['member-1'])).toBe('legacy_family_unproved:no_session');
});

it('refuses a member with no recorded preference when no producer is composed', async () => {
  prepareCoverageContract(store.db, 1);
  reads({ 'member-1': representation({ selection: 'unknown' }) });

  expect(await fence(['member-1'])).toBe('legacy_family_producer_unavailable');
});

it('admits a member whose recorded preference is this family', async () => {
  prepareCoverageContract(store.db, 1);
  reads({ 'member-1': representation() });

  expect(await fence(['member-1'])).toBeUndefined();
});

it('refuses a window holding a member whose session chose the other family', async () => {
  prepareCoverageContract(store.db, 1);
  reads({
    'member-1': representation(),
    'member-2': representation({ selection: 'not_selected' }),
  });

  expect(await fence(['member-1', 'member-2'])).toBe('legacy_family_changed');
});

it('refuses a window whose member rests on a retired representation', async () => {
  prepareCoverageContract(store.db, 1);
  seam.lineage.mockResolvedValue([{ id: 'summary-1', ancestors: ['retired-1'], bounded: false }]);
  reads({
    'summary-1': representation({ family: 'unknown', sessions: [] }),
    'retired-1': representation({ selection: 'not_selected' }),
  });

  expect(await fence(['summary-1'])).toBe('legacy_family_changed');
});

it('refuses a window holding a family that publishes through its own manifest', async () => {
  prepareCoverageContract(store.db, 1);
  reads({ 'overview-1': representation({ family: 'overview' }) });

  expect(await fence(['overview-1'])).toBe('legacy_family_foreign');
});

it('refuses a window whose ancestry it cannot enumerate whole', async () => {
  prepareCoverageContract(store.db, 1);
  seam.lineage.mockResolvedValue([{ id: 'member-1', ancestors: [], bounded: true }]);

  expect(await fence(['member-1'])).toBe('legacy_family_scan_bound');
  expect(seam.read).not.toHaveBeenCalled();
});

it('refuses a window whose member the ancestry read did not answer for', async () => {
  prepareCoverageContract(store.db, 1);
  seam.lineage.mockResolvedValue([]);

  expect(await fence(['member-1'])).toBe('legacy_family_scan_bound');
});

it('refuses a window whose members and ancestry together pass the proof bound', async () => {
  prepareCoverageContract(store.db, 1);
  const ancestors = Array.from(
    { length: ROLLUP_FAMILY_SCAN_LIMIT },
    (_, index) => `ancestor-${String(index)}`,
  );
  seam.lineage.mockResolvedValue([{ id: 'member-1', ancestors, bounded: false }]);

  expect(await fence(['member-1'])).toBe('legacy_family_scan_bound');
  expect(seam.read).not.toHaveBeenCalled();
});

it.each([
  ['unreadable family record', 'unknown', 'established', 'store_unavailable'],
  ['unacknowledged publication', 'selected', 'unknown', 'pending_publication'],
] as const)(
  'refuses %s instead of treating it as never initialized',
  async (_label, selection, publication, reason) => {
    prepareCoverageContract(store.db, 1);
    seam.read.mockResolvedValue({
      values: new Map([['member-1', representation({ selection, publication })]]),
      dependencies: [],
      issues: [
        {
          address: { kind: 'id', id: 'member-1' },
          field: publication === 'unknown' ? 'narrative_revision' : 'representation_preference',
          reason,
          required: true,
        },
      ],
    });
    expect(await fence(['member-1'])).not.toBeUndefined();
  },
);

it('refuses a missing identity answer instead of treating it as an open family', async () => {
  prepareCoverageContract(store.db, 1);
  reads({});
  expect(await fence(['member-1'])).not.toBeUndefined();
});
