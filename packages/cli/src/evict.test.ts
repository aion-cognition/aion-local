import type { CoverageStateReport } from '@aion/core';
import { describe, expect, it } from 'vitest';

import { evictionFence } from './doctor-checks.js';
import {
  ARM_CONFIRMATION,
  parseEvictFlags,
  writeNotVerified,
  writePreconditions,
} from './evict.js';

describe('parseEvictFlags', () => {
  it('reads status by default and takes either subcommand', () => {
    expect(parseEvictFlags([])).toEqual({ action: 'status', yes: false });
    expect(parseEvictFlags(['status'])).toEqual({ action: 'status', yes: false });
    expect(parseEvictFlags(['arm', '--yes'])).toEqual({ action: 'arm', yes: true });
  });

  it('reads a bare flag as status, so the destructive act always has to be named', () => {
    expect(parseEvictFlags(['--yes'])).toEqual({ action: 'status', yes: true });
  });

  it('rejects an unknown subcommand and an unknown option', () => {
    expect(() => parseEvictFlags(['unarm'])).toThrow();
    expect(() => parseEvictFlags(['arm', '--force'])).toThrow("unknown option '--force'");
  });
});

describe('writePreconditions', () => {
  const holds = { name: 'a condition', reason: 'r1', holds: true, detail: 'fine' };
  const fails = { name: 'another', reason: 'r2', holds: false, detail: 'not fine' };

  it('prints every check and answers whether all of them hold', () => {
    const said: string[] = [];
    expect(writePreconditions([holds, fails], (line) => said.push(line))).toBe(false);
    expect(said).toEqual(['  [ok] a condition: fine', '  [--] another: not fine']);
    expect(writePreconditions([holds], () => undefined)).toBe(true);
  });

  it('reports an empty list as ready, which only a build with no checks could produce', () => {
    expect(writePreconditions([], () => undefined)).toBe(true);
  });
});

describe('the honest-gaps section', () => {
  it('names what the checks do not cover, and says no check below can', () => {
    const said: string[] = [];
    writeNotVerified((line) => said.push(line));

    expect(said[0]).toBe('not verified here, and nothing below can be:');
    expect(said.length).toBeGreaterThan(1);
    expect(said.slice(1).every((line) => line.startsWith('  - '))).toBe(true);
    expect(said.join(' ')).toContain('writer audit');
  });

  it('carries the same warning into the question the operator answers', () => {
    // The last thing read before the answer has to be the gap, not the passing table above it.
    expect(ARM_CONFIRMATION).toContain('unverified');
  });
});

describe('parseEvictFlags on the stop', () => {
  it('reads disarm as its own act, never as a default', () => {
    expect(parseEvictFlags(['disarm'])).toEqual({ action: 'disarm', yes: false });
    expect(parseEvictFlags(['disarm', '--yes'])).toEqual({ action: 'disarm', yes: true });
    expect(parseEvictFlags([]).action).toBe('status');
  });
});

describe('evictionFence', () => {
  const report = (over: Partial<CoverageStateReport>): CoverageStateReport => ({
    coverageState: 'active',
    historySince: null,
    coverageEpoch: 'epoch-1',
    evictionGate: 'unarmed',
    evictionCompatibilityRevision: 0,
    evictionDisarmedAt: null,
    ...over,
  });

  it('keeps never-opened and opened-then-stopped apart', () => {
    expect(evictionFence(report({}))).toContain('closed');
    expect(
      evictionFence(report({ evictionGate: 'armed', evictionCompatibilityRevision: 1 })),
    ).toContain('ARMED at compatibility revision 1');
    const stopped = evictionFence(
      report({
        evictionGate: 'disarmed',
        evictionCompatibilityRevision: 1,
        evictionDisarmedAt: '2026-09-12T10:00:00.000Z',
      }),
    );
    expect(stopped).toContain('DISARMED at 2026-09-12T10:00:00.000Z');
    // The revision it established is still on the line: a stop is not the loss of a capability.
    expect(stopped).toContain('compatibility revision 1 stands');
  });
});
