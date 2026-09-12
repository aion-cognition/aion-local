import { INSTALLED_PUBLICATION_KINDS, SqliteStore, type CoverageStateReport } from '@aion/core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evictionFence } from './doctor-checks.js';
import {
  ARM_CONFIRMATION,
  parseEvictFlags,
  runEvict,
  runEvictAct,
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

describe('which set the tables are measured against', () => {
  /**
   * The one line the fence calls non-spoofable, and the one a surface can most easily make
   * meaningless. Asking the declared list whether every declared kind is installed answers itself:
   * the line prints `[ok]` on a substrate the operation then refuses. There is no behavioural
   * difference to assert while the two sets agree, which is exactly why the argument is pinned
   * where a later edit would change it.
   */
  it('hands the precondition table the set the command composes', () => {
    const source = readFileSync(fileURLToPath(new URL('./evict.ts', import.meta.url)), 'utf8');
    const calls = [...source.matchAll(/armingPreconditions\(\s*db,\s*([A-Za-z_]+)/g)];
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.map((match) => match[1])).toEqual(calls.map(() => 'INSTALLED_PUBLICATION_KINDS'));
    // And the set is a real answer about this build rather than the declared list renamed.
    expect(INSTALLED_PUBLICATION_KINDS.length).toBeGreaterThan(0);
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
    evictionStopRequestedBy: null,
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

/**
 * The command's own output, not the helper's.
 *
 * Both call sites are the substance: a status read or a pre-arm table printed without the gaps
 * beside it is exactly the reading the section exists to prevent, and a helper asserted in
 * isolation says nothing about whether anybody calls it.
 */
describe('what `aion evict` actually prints', () => {
  let dir: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-evict-surface-'));
    saved = { ...process.env };
    process.env.AION_SQLITE_PATH = join(dir, 'aion.sqlite');
    process.env.AION_LOG_FILE = join(dir, 'aion.jsonl');
    process.env.AION_LOG_LEVEL = 'fatal';
  });

  afterEach(() => {
    // Replace the object rather than edit it: these roots run in a forked worker and a key this
    // case added has to go, not just be overwritten.
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  async function output(argv: readonly string[]): Promise<string[]> {
    const said: string[] = [];
    await runEvict(argv, (line) => said.push(line));
    return said;
  }

  it('carries the gaps on a status read, under the table', async () => {
    const said = await output(['status']);

    const heading = said.indexOf('not verified here, and nothing below can be:');
    expect(heading).toBeGreaterThan(0);
    expect(said.some((line) => line.startsWith('  ['))).toBe(true);
    // Under the table it qualifies, never above it.
    expect(said.findIndex((line) => line.startsWith('  ['))).toBeLessThan(heading);
    expect(said.join('\n')).toContain('writer audit');
  });

  async function armTable(): Promise<{ said: string[]; prompts: string[] }> {
    const said: string[] = [];
    const prompts: string[] = [];
    const store = new SqliteStore({ filePath: join(dir, 'act.sqlite') });
    try {
      // The end state a bootstrapped, coverage-active substrate is in, written directly: what is
      // under test here is what the command prints and asks, and the fence's own semantics have
      // their own batteries in core.
      store.db
        .prepare(
          `INSERT INTO publication_control
             (substrate_id, bootstrap_state, protocol_version, activation_capability_revision)
           VALUES ('s1', 'initialized', 1, 1)`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO coverage_contract
             (epoch, history_since, activated_at, field_policy_version, state)
           VALUES ('epoch-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 1, 'active')`,
        )
        .run();
      await runEvictAct(
        'arm',
        store.db,
        () =>
          Promise.resolve({
            status: 'deferred',
            operationId: 'op-1',
            sequence: '1',
            reason: 'substrate_not_initialized',
          }),
        (prompt) => {
          prompts.push(prompt);
          return Promise.resolve(true);
        },
        (line) => said.push(line),
      );
    } finally {
      store.close();
    }
    return { said, prompts };
  }

  it('carries the gaps before the question on the pre-arm table', async () => {
    const { said } = await armTable();

    const heading = said.indexOf('not verified here, and nothing below can be:');
    expect(heading).toBeGreaterThan(0);
    expect(said.findIndex((line) => line.startsWith('  ['))).toBeLessThan(heading);
    expect(said.join('\n')).toContain('writer audit');
  });

  it('asks with the unverified half in the question, and only after printing it', async () => {
    const { said, prompts } = await armTable();

    // The question the operator answers is the question the command assembled, and it names the
    // half no check covered.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('unverified');
    expect(said.indexOf('not verified here, and nothing below can be:')).toBeGreaterThan(-1);
  });
});
