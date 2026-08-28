import { describe, expect, it } from 'vitest';
import { runChecks, summarize, type Check, type CheckReport } from './doctor.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function passing(name: string, detail = 'fine'): Check {
  return { name, run: async () => ({ ok: true, detail }) };
}

describe('runChecks', () => {
  it('runs every check in order and reports each result', async () => {
    const { lines, write } = collector();

    const reports = await runChecks([passing('a'), passing('b', 'also fine')], write);

    expect(reports.map((report) => report.name)).toEqual(['a', 'b']);
    expect(lines).toEqual(['ok    a: fine', 'ok    b: also fine']);
  });

  it('skips a check whose dependency failed instead of running it', async () => {
    const { write } = collector();
    let ran = false;
    const checks: Check[] = [
      { name: 'neo4j-bolt', run: async () => ({ ok: false, detail: 'connection refused' }) },
      {
        name: 'neo4j-gds',
        dependsOn: 'neo4j-bolt',
        run: async () => {
          ran = true;
          return { ok: true, detail: 'unreachable in practice' };
        },
      },
    ];

    const reports = await runChecks(checks, write);

    expect(ran).toBe(false);
    expect(reports[1]).toEqual({ name: 'neo4j-gds', ok: false, detail: 'not checked: neo4j-bolt failed' });
  });

  it('still runs a check whose dependency passed', async () => {
    const { write } = collector();

    const reports = await runChecks(
      [passing('neo4j-bolt'), { name: 'graph-schema', dependsOn: 'neo4j-bolt', run: async () => ({ ok: true, detail: 'migration 001 applied' }) }],
      write,
    );

    expect(reports[1]?.ok).toBe(true);
  });

  it('turns a thrown named error into a failed check keeping the error name', async () => {
    const { write } = collector();
    const failure = new Error('vector index content_vec_idx was created at 768 dimensions');
    failure.name = 'VectorIndexDimensionMismatchError';

    const reports = await runChecks(
      [
        {
          name: 'vector-index-dimension',
          run: async () => {
            throw failure;
          },
        },
      ],
      write,
    );

    expect(reports[0]?.ok).toBe(false);
    expect(reports[0]?.detail).toContain('VectorIndexDimensionMismatchError:');
  });
});

describe('summarize', () => {
  it('exits 0 and counts the checks when all pass', () => {
    const { lines, write } = collector();
    const reports: CheckReport[] = [
      { name: 'a', ok: true, detail: '' },
      { name: 'b', ok: true, detail: '' },
    ];

    expect(summarize(reports, write)).toBe(0);
    expect(lines[0]).toContain('2 checks passed');
  });

  it('exits 1 and names every failing check', () => {
    const { lines, write } = collector();
    const reports: CheckReport[] = [
      { name: 'neo4j-bolt', ok: false, detail: 'refused' },
      { name: 'sqlite-wal', ok: true, detail: '' },
      { name: 'neo4j-gds', ok: false, detail: 'not checked' },
    ];

    expect(summarize(reports, write)).toBe(1);
    expect(lines[0]).toContain('2 of 3 checks failed: neo4j-bolt, neo4j-gds');
  });
});
