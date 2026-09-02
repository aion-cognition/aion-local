import { DEFAULTS, type GraphConnection } from '@aion/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Substrate, SubstrateCommand } from './substrate.js';

const seam = vi.hoisted(() => ({
  /** The signal a forced run's operation was actually handed. */
  capturedSignal: undefined as AbortSignal | undefined,
}));

vi.mock('@aion/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realOperations = actual.introspectionOperations as () => readonly unknown[];
  const fakeOperation = {
    name: 'test_forced_op',
    bucket: 'day',
    relevance: () => 0,
    run: async ({ signal }: { readonly signal: AbortSignal }) => {
      seam.capturedSignal = signal;
      return { status: 'ok', itemsProcessed: 0, itemsAffected: 0 };
    },
  };
  return {
    ...actual,
    // The real catalog, plus one fake operation the abort test drives, so `ls` still lists
    // every registered operation the way it does in production.
    introspectionOperations: () => [...realOperations(), fakeOperation],
    observeHealth: async () => ({ degraded: [] }),
    markLedgerApplied: () => undefined,
    operationBucketKey: () => 'test-key',
    ProviderRouter: class {
      forRole(): unknown {
        return {};
      }
    },
  };
});

/**
 * Every command opens its own config, logger, database and driver through this; the stub hands
 * back a connection nothing here reaches, so `run <operation>` runs to the operation call
 * without a substrate to talk to.
 */
vi.mock('./substrate.js', () => ({
  withSubstrate: async (command: SubstrateCommand<unknown>): Promise<number> =>
    await command.run(stubSubstrate(), command.parse(command.argv)),
}));

function stubSubstrate(): Substrate {
  const noop = (): void => undefined;
  const connection = { driver: {}, uri: 'bolt://fake' } as unknown as GraphConnection;
  return {
    config: DEFAULTS,
    write: noop,
    logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    db: () => ({}),
    connection: () => connection,
    requireGraph: async () => connection,
  } as unknown as Substrate;
}

const { parseMaintainFlags, runMaintain } = await import('./maintain.js');

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

beforeEach(() => {
  seam.capturedSignal = undefined;
});

describe('parseMaintainFlags', () => {
  it('defaults to listing the catalog', () => {
    expect(parseMaintainFlags([])).toEqual({ subcommand: 'ls' });
  });

  it('takes the operation name for a forced run', () => {
    expect(parseMaintainFlags(['run', 'redaction_residue_purge'])).toEqual({
      subcommand: 'run',
      operation: 'redaction_residue_purge',
    });
  });

  it('refuses a run with no operation named', () => {
    expect(() => parseMaintainFlags(['run'])).toThrow('maintain run needs an operation name');
  });

  it('refuses a subcommand it does not have', () => {
    expect(() => parseMaintainFlags(['force'])).toThrow(
      "unknown maintain subcommand 'force' (supported: ls, run)",
    );
  });
});

describe('aion maintain ls', () => {
  it('names every registered operation and which condition it answers', async () => {
    const out = collector();
    expect(await runMaintain(['ls'], out.write)).toBe(0);

    const listing = out.lines.join('\n');
    // The escape hatch exists for this one: a leak is an incident to a person and a small
    // share to a scoring function.
    expect(listing).toContain('redaction_residue_purge');
    expect(listing).toContain(
      'emergency_relationship_repair  quarter-hour window, critical responder for missing_backbone_links',
    );
    expect(listing).toContain(
      'orphan_cleanup  quarter-hour window, critical responder for orphan_share',
    );
    expect(listing).toContain(
      'vector_backfill  quarter-hour window, critical responder for vector_parity',
    );
    expect(listing).toContain('community_refresh  day window, routine');
    expect(listing).toContain('proposal_hygiene  day window, routine');
    // merge_shadow judged what merge_auto would do without ever acting on it; merge_auto
    // itself already acts, so the shadow judge is retired rather than a selectable lane.
    expect(listing).not.toContain('merge_shadow');
  });
});

describe('aion maintain run', () => {
  it('aborts a forced run on SIGINT rather than leaving it uninterruptible', async () => {
    const out = collector();

    expect(await runMaintain(['run', 'test_forced_op'], out.write)).toBe(0);

    expect(seam.capturedSignal).toBeDefined();
    expect(seam.capturedSignal?.aborted).toBe(false);

    process.emit('SIGINT');

    expect(seam.capturedSignal?.aborted).toBe(true);
  });
});
