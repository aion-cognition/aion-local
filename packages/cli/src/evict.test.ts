import { describe, expect, it } from 'vitest';

import { parseEvictFlags, writePreconditions } from './evict.js';

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
    expect(() => parseEvictFlags(['disarm'])).toThrow();
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
