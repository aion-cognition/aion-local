import {
  DEFAULTS,
  enqueueReflectionJob,
  type GraphConnection,
  SqliteStore,
  type Config,
  type SqliteHandle,
} from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { horizonIntegrityCheck, queueLagCheck } from './doctor-checks.js';
import {
  buildDoctorChecks,
  probeMcpHttp,
  probeServiceFreshness,
  runChecks,
  summarize,
  type Check,
  type CheckReport,
  type CheckResult,
} from './doctor.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

function passing(name: string, detail = 'fine'): Check {
  return { name, run: async () => ({ ok: true, detail }) };
}

/**
 * The one check that talks to Ollama, run against a stubbed host. Neo4j and SQLite are never
 * touched by it, which is why the other two dependencies can be absent here.
 */
async function runOllamaCheck(config: Config): Promise<{ result: CheckResult; paths: string[] }> {
  const paths: string[] = [];
  const fetchImpl = vi.fn((url: string | URL) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/api/version') {
      return Promise.resolve(new Response(JSON.stringify({ version: '0.24.0' })));
    }
    if (path === '/api/embed') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            embeddings: [new Array<number>(DEFAULTS.models.embedDimension).fill(0.1)],
          }),
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ done: true, message: { role: 'assistant', content: 'hi' } })),
    );
  });
  vi.stubGlobal('fetch', fetchImpl);
  try {
    const checks = buildDoctorChecks({
      config,
      connection: undefined as unknown as GraphConnection,
      db: undefined as unknown as SqliteHandle,
    });
    const check = checks.find((candidate) => candidate.name === 'ollama-round-trip');
    if (check === undefined) {
      throw new Error('no ollama-round-trip check');
    }
    return { result: await check.run(), paths };
  } finally {
    vi.unstubAllGlobals();
  }
}

describe('the Ollama round-trip check under routing', () => {
  it('round-trips the embed model and every chat model that still routes locally', async () => {
    const { result, paths } = await runOllamaCheck(DEFAULTS);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`${String(DEFAULTS.models.embedDimension)} dimensions`);
    expect(result.detail).toContain(`chat ${DEFAULTS.models.cue}, ${DEFAULTS.models.reflect} ok`);
    expect(paths.filter((path) => path === '/api/chat')).toHaveLength(2);
  });

  it('checks no chat model the key covers, and names where those roles went', async () => {
    const keyed: Config = {
      ...DEFAULTS,
      anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-ant-test' },
    };

    const { result, paths } = await runOllamaCheck(keyed);

    expect(result.ok).toBe(true);
    expect(paths).not.toContain('/api/chat');
    expect(result.detail).toContain('no chat model routes locally');
    expect(result.detail).toContain(
      `cue, reflect routed to anthropic (${DEFAULTS.anthropic.model})`,
    );
  });

  it('still checks the chat model a pin kept local', async () => {
    const split: Config = {
      ...DEFAULTS,
      anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-ant-test' },
      routing: { cue: 'ollama', reflect: 'auto' },
    };

    const { result, paths } = await runOllamaCheck(split);

    expect(paths.filter((path) => path === '/api/chat')).toHaveLength(1);
    expect(result.detail).toContain(`chat ${DEFAULTS.models.cue} ok`);
    expect(result.detail).toContain('reflect routed to anthropic');
  });
});

/** The env bit is injected, so no test ever depends on the machine's own `~/.claude`. */
function runHooksCheck(config: Config, env: NodeJS.ProcessEnv): Promise<CheckResult> {
  const checks = buildDoctorChecks({
    config,
    connection: undefined as unknown as GraphConnection,
    db: undefined as unknown as SqliteHandle,
    env,
  });
  const check = checks.find((candidate) => candidate.name === 'hooks-keyed-only');
  if (check === undefined) {
    throw new Error('no hooks-keyed-only check');
  }
  return check.run();
}

describe('the hooks-keyed-only check', () => {
  const keyed: Config = {
    ...DEFAULTS,
    anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-ant-test' },
  };

  it('fails an install whose reflection runs on a local model', async () => {
    const result = await runHooksCheck(DEFAULTS, { AION_HOOKS_INSTALLED: 'true' });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(DEFAULTS.models.reflect);
    expect(result.detail).toContain('AION_ANTHROPIC_API_KEY');
    expect(result.detail).toContain('aion hooks uninstall');
  });

  it('names the fire the hook client removes itself on, not a session boundary', async () => {
    const result = await runHooksCheck(DEFAULTS, { AION_HOOKS_INSTALLED: 'true' });

    expect(result.detail).toContain('strips them on its next fire');
  });

  it('fails an install whose key a pin sends back to the local model', async () => {
    const pinned: Config = { ...keyed, routing: { cue: 'auto', reflect: 'ollama' } };

    const result = await runHooksCheck(pinned, { AION_HOOKS_INSTALLED: 'true' });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(DEFAULTS.models.reflect);
  });

  it('passes an install whose reflection routes to anthropic', async () => {
    const result = await runHooksCheck(keyed, { AION_HOOKS_INSTALLED: 'true' });

    expect(result).toEqual({ ok: true, detail: 'hooks installed, keyed' });
  });

  it('passes a host with no hooks installed', async () => {
    const result = await runHooksCheck(DEFAULTS, { AION_HOOKS_INSTALLED: 'false' });

    expect(result).toEqual({ ok: true, detail: 'no hooks installed' });
  });

  it('passes when nothing computed the fact for this run', async () => {
    const result = await runHooksCheck(DEFAULTS, {});

    expect(result).toEqual({ ok: true, detail: 'hook settings not visible here' });
  });
});

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
    expect(reports[1]).toEqual({
      name: 'neo4j-gds',
      ok: false,
      detail: 'not checked: neo4j-bolt failed',
    });
  });

  it('still runs a check whose dependency passed', async () => {
    const { write } = collector();

    const reports = await runChecks(
      [
        passing('neo4j-bolt'),
        {
          name: 'graph-schema',
          dependsOn: 'neo4j-bolt',
          run: async () => ({ ok: true, detail: 'migration 001 applied' }),
        },
      ],
      write,
    );

    expect(reports[1]?.ok).toBe(true);
  });

  it('marks a warning check without failing it', async () => {
    const { lines, write } = collector();

    const reports = await runChecks(
      [
        {
          name: 'enrichment-reconcile',
          run: async () => ({ ok: true, warn: true, detail: '412 behind' }),
        },
      ],
      write,
    );

    expect(reports[0]?.ok).toBe(true);
    expect(lines).toEqual(['warn  enrichment-reconcile: 412 behind']);
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

describe('probeServiceFreshness', () => {
  const healthWith = (buildSha: string | undefined) => async () =>
    new Response(JSON.stringify({ status: 'ok', build_sha: buildSha }), { status: 200 });

  it('reports ok when the running service matches the repo head', async () => {
    const result = await probeServiceFreshness(8765, 'abc1234', healthWith('abc1234'));

    expect(result).toEqual({ ok: true, detail: 'service and repo both at abc1234' });
  });

  it('warns when the running service trails the repo head', async () => {
    const result = await probeServiceFreshness(8765, 'def5678', healthWith('abc1234'));

    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.detail).toContain('abc1234');
    expect(result.detail).toContain('def5678');
  });

  it('warns on an unstamped image instead of guessing', async () => {
    const result = await probeServiceFreshness(8765, 'abc1234', healthWith(undefined));

    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.detail).toContain('no build sha');
  });

  it('warns when the repo head is unknown to the CLI', async () => {
    const result = await probeServiceFreshness(8765, undefined, healthWith('abc1234'));

    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
  });
});

describe('probeMcpHttp', () => {
  it('reports ok with the session count from a healthy response', async () => {
    const fetchImpl = async (url: string | URL) => {
      expect(String(url)).toBe('http://127.0.0.1:8765/health');
      return new Response(JSON.stringify({ status: 'ok', sessions: 3, descriptions_version: 1 }), {
        status: 200,
      });
    };

    const result = await probeMcpHttp(8765, fetchImpl as unknown as typeof fetch);

    expect(result).toEqual({ ok: true, detail: 'http://127.0.0.1:8765/health, 3 sessions' });
  });

  it('fails on a non-2xx response', async () => {
    const fetchImpl = async () => new Response('not found', { status: 404 });

    const result = await probeMcpHttp(8765, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('404');
  });

  it('fails on an unexpected health payload', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ status: 'degraded' }), { status: 200 });

    const result = await probeMcpHttp(8765, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unexpected health payload');
  });
});

describe('queueLagCheck', () => {
  let dir: string;
  let store: SqliteStore;
  let config: Config;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-doctor-queue-lag-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    config = {
      ...DEFAULTS,
      operational: {
        ...DEFAULTS.operational,
        lagOldestUnclaimedWarnMs: 600_000,
        lagQueueDepthWarnThreshold: 200,
      },
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes clean on an empty queue', () => {
    const result = queueLagCheck(store.db, config);

    expect(result.ok).toBe(true);
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain('depth 0');
  });

  it('warns, never fails, once the oldest unclaimed job is past the threshold', () => {
    enqueueReflectionJob(store.db, 'integrate', { episode_id: 'e1' }, { lane: 'interactive' });
    const now = new Date();
    store.db
      .prepare('UPDATE reflection_queue SET enqueued_at = ?')
      .run(new Date(now.getTime() - 700_000).toISOString());

    const result = queueLagCheck(store.db, config, now);

    expect(result.ok).toBe(true);
    expect(result.warn).toBe(true);
    expect(result.detail).toContain('oldest unclaimed 700s');
  });

  it('warns once total unclaimed depth passes the threshold, ages aside', () => {
    for (let index = 0; index < 201; index += 1) {
      enqueueReflectionJob(
        store.db,
        'integrate',
        { episode_id: `e${String(index)}` },
        { lane: 'bulk' },
      );
    }

    const result = queueLagCheck(store.db, config);

    expect(result.warn).toBe(true);
    expect(result.detail).toContain('depth 201');
  });

  it('stays clean under both thresholds', () => {
    enqueueReflectionJob(store.db, 'integrate', { episode_id: 'e1' }, { lane: 'interactive' });

    const result = queueLagCheck(store.db, config);

    expect(result.warn).toBeUndefined();
  });
});

describe('horizonIntegrityCheck', () => {
  it('passes a substrate that has written no horizon at all', () => {
    const result = horizonIntegrityCheck({
      withHorizon: 0,
      closed: 0,
      closedAtHorizon: 0,
      sampleIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.warn).toBeUndefined();
    expect(result.detail).toContain('0 readings carry a horizon');
  });

  /**
   * A reading a later observation corrected carries the close and the horizon at once, and
   * that is the ordinary shape. A check that read the pair as the fault would fire on every
   * corrected reading in the substrate.
   */
  it('passes a corrected reading, which carries a close and a horizon together', () => {
    const result = horizonIntegrityCheck({
      withHorizon: 4,
      closed: 2,
      closedAtHorizon: 0,
      sampleIds: [],
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('4 readings carry a horizon, 2 of them superseded');
  });

  it('fails a node whose close is stamped at its own horizon, and names it', () => {
    const result = horizonIntegrityCheck({
      withHorizon: 4,
      closed: 2,
      closedAtHorizon: 1,
      sampleIds: ['reading-queue-depth'],
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('1 of 4');
    expect(result.detail).toContain('reading-queue-depth');
    expect(result.detail).toContain('aion unsupersede');
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

  // A backlog is a thing that is behind, not a thing that is broken; naming it in the summary
  // without changing the exit code is what keeps `aion doctor` usable as a gate.
  it('names warnings alongside a pass and still exits 0', () => {
    const { lines, write } = collector();
    const reports: CheckReport[] = [
      { name: 'a', ok: true, detail: '' },
      { name: 'enrichment-reconcile', ok: true, warn: true, detail: '412 behind' },
    ];

    expect(summarize(reports, write)).toBe(0);
    expect(lines[0]).toContain('2 checks passed, 1 warning: enrichment-reconcile');
  });
});
