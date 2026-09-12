import { INSTALLED_PUBLICATION_KINDS, SqliteStore, type CoverageStateReport } from '@aion/core';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evictionFence } from './doctor-checks.js';
import {
  parseEvictFlags,
  runEvict,
  runEvictDisarm,
  runEvictRearm,
  standingStop,
  writeNotVerified,
  writePreconditions,
} from './evict.js';

describe('parseEvictFlags', () => {
  it('reads status by default and takes either subcommand', () => {
    expect(parseEvictFlags([])).toEqual({ action: 'status', yes: false });
    expect(parseEvictFlags(['status'])).toEqual({ action: 'status', yes: false });
    expect(parseEvictFlags(['disarm', '--yes'])).toEqual({ action: 'disarm', yes: true });
  });

  it('reads a bare flag as status, so the destructive act always has to be named', () => {
    expect(parseEvictFlags(['--yes'])).toEqual({ action: 'status', yes: true });
  });

  it('rejects an unknown subcommand and an unknown option', () => {
    expect(() => parseEvictFlags(['unarm'])).toThrow();
    expect(() => parseEvictFlags(['disarm', '--force'])).toThrow("unknown option '--force'");
  });

  it('refuses `arm`, which the service now does at start, and says what it takes instead', () => {
    // Not silently accepted and not silently ignored: somebody who learned the manual step reads
    // the supported list here rather than watching a command exit 0 having armed nothing, and the
    // list names `rearm`, which is what they actually want on a stopped substrate.
    expect(() => parseEvictFlags(['arm'])).toThrow('status, disarm, rearm');
  });

  it('reads rearm as its own act', () => {
    expect(parseEvictFlags(['rearm'])).toEqual({ action: 'rearm', yes: false });
    expect(parseEvictFlags(['rearm', '--yes']).yes).toBe(true);
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
    // One call site since the arm act left this file: the status read. The other reader of the
    // table is the operation's own check, which takes the set from the coordinator holding it.
    expect(calls.length).toBeGreaterThan(0);
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

  it('rides with every arming decision, from one definition', () => {
    // Two call sites, one list: the status read, and the re-arm, which is the only decision left
    // that opens the capability. A third would be somewhere for the wording to drift.
    const source = readFileSync(fileURLToPath(new URL('./evict.ts', import.meta.url)), 'utf8');
    expect(source.split('writeNotVerified(write)')).toHaveLength(3);
    expect(source.split('export function writeNotVerified')).toHaveLength(2);
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

  async function disarmTable(): Promise<{ said: string[]; prompts: string[] }> {
    const said: string[] = [];
    const prompts: string[] = [];
    const store = new SqliteStore({ filePath: join(dir, 'act.sqlite') });
    try {
      // The end state a bootstrapped, coverage-active, armed substrate is in, written directly:
      // what is under test here is what the command prints and asks, and the fence's own
      // semantics have their own batteries in core.
      store.db
        .prepare(
          `INSERT INTO publication_control
             (substrate_id, bootstrap_state, protocol_version, activation_capability_revision,
              eviction_compatibility_revision)
           VALUES ('s1', 'initialized', 1, 1, 1)`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO coverage_contract
             (epoch, history_since, activated_at, field_policy_version, state)
           VALUES ('epoch-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 1, 'active')`,
        )
        .run();
      await runEvictDisarm(
        store.db,
        () =>
          Promise.resolve({
            status: 'deferred' as const,
            operationId: 'op-1',
            sequence: '1',
            reason: 'already_disarmed',
          }),
        (prompt: string) => {
          prompts.push(prompt);
          return Promise.resolve(true);
        },
        (line: string) => said.push(line),
      );
    } finally {
      store.close();
    }
    return { said, prompts };
  }

  it('prints the stop table and says the stop survives a restart', async () => {
    const { said } = await disarmTable();

    expect(said.some((line) => line.startsWith('  ['))).toBe(true);
    // The one thing an operator has to know now that the service arms on its own: this is not
    // undone by the next boot.
    expect(said.join('\n')).toContain('does not re-arm a substrate you stopped');
  });

  it('asks once, and does not restate the unverified list the status read owns', async () => {
    const { said, prompts } = await disarmTable();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('stop eviction on this substrate?');
    expect(said.join('\n')).not.toContain('not verified here');
  });

  async function rearm(stop: {
    readonly disarmedAt?: string;
    readonly owedBy?: string;
  }): Promise<{ said: string[]; prompts: string[]; published: number; code: number }> {
    const said: string[] = [];
    const prompts: string[] = [];
    let published = 0;
    const store = new SqliteStore({ filePath: join(dir, `rearm-${String(Date.now())}.sqlite`) });
    try {
      store.db
        .prepare(
          `INSERT INTO publication_control
             (substrate_id, bootstrap_state, protocol_version, activation_capability_revision,
              eviction_compatibility_revision, eviction_disarmed_at, eviction_stop_requested_by)
           VALUES ('s1', 'initialized', 1, 1, 1, ?, ?)`,
        )
        .run(stop.disarmedAt ?? null, stop.owedBy ?? null);
      store.db
        .prepare(
          `INSERT INTO coverage_contract
             (epoch, history_since, activated_at, field_policy_version, state)
           VALUES ('epoch-1', '2026-09-12T00:00:00.000Z', '2026-09-12T00:00:00.000Z', 1, 'active')`,
        )
        .run();
      const code = await runEvictRearm(
        store.db,
        () => {
          published += 1;
          return Promise.resolve({
            status: 'acknowledged' as const,
            operationId: 'op-1',
            sequence: '1',
            result: { act: 'rearm', revision: 1 },
            knownFrom: '2026-09-12T12:00:00.000Z',
            observedAckAt: '2026-09-12T12:00:00.000Z',
            clockClamped: false,
          });
        },
        (prompt: string) => {
          prompts.push(prompt);
          return Promise.resolve(true);
        },
        (line: string) => said.push(line),
      );
      return { said, prompts, published, code };
    } finally {
      store.close();
    }
  }

  it('names the stop it lifts and when the substrate recorded it, in the question', async () => {
    const { said, prompts, published } = await rearm({ disarmedAt: '2026-09-12T09:00:00.000Z' });

    expect(said[0]).toContain('the stop recorded at 2026-09-12T09:00:00.000Z');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('the stop recorded at 2026-09-12T09:00:00.000Z');
    // The gaps ride with it: this is the one decision left that opens the capability.
    expect(prompts[0]).toContain('unverified');
    expect(said.join('\n')).toContain('not verified here');
    expect(published).toBe(1);
    expect(said.join('\n')).toContain('a restart keeps it armed');
  });

  it('names a stop that was asked for and never recorded, and lifts that one too', async () => {
    // The case the service start refuses on purpose. A person naming it out loud is when clearing
    // it is right, and the operation that owed it is named in the question.
    const { prompts, published } = await rearm({ owedBy: 'disarm-that-never-finished' });

    expect(prompts[0]).toContain('the stop owed by disarm-that-never-finished');
    expect(prompts[0]).toContain('never recorded');
    expect(published).toBe(1);
  });

  it('is a no-op with a message on a substrate nobody stopped', async () => {
    const { said, prompts, published, code } = await rearm({});

    expect(code).toBe(0);
    expect(published).toBe(0);
    expect(prompts).toEqual([]);
    expect(said.join('\n')).toContain('nothing to lift');
  });
});

describe('standingStop', () => {
  const report = (over: Partial<CoverageStateReport>): CoverageStateReport => ({
    coverageState: 'active',
    historySince: null,
    coverageEpoch: 'epoch-1',
    evictionGate: 'armed',
    evictionCompatibilityRevision: 1,
    evictionDisarmedAt: null,
    evictionStopRequestedBy: null,
    ...over,
  });

  it('prefers the recorded stamp over the claim, since the stamp is the finished statement', () => {
    expect(
      standingStop(
        report({ evictionDisarmedAt: '2026-09-12T09:00:00.000Z', evictionStopRequestedBy: 'op-2' }),
      ),
    ).toContain('recorded at 2026-09-12T09:00:00.000Z');
    expect(standingStop(report({}))).toBeUndefined();
  });
});
