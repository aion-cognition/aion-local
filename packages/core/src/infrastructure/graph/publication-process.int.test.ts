import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './test-support/consolidation-rehearsal.fixture.js';
import {
  ProbePublication,
  readPublicationProbe,
  seedPublicationProbe,
  type ProbePayload,
} from './test-support/publication-operation.fixture.js';
import { PublicationCoordinator } from '../publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../publication/handlers.js';
import type { PublicationMetric } from '../publication/types.js';
import { SqliteStore } from '../sqlite/database.js';
import { getLedgerEntry } from '../sqlite/ops-ledger.js';

const childPath = fileURLToPath(
  new URL('./test-support/publication-process.fixture.ts', import.meta.url),
);
const hookPath = fileURLToPath(new URL('../sqlite/ts-specifier-hook.fixture.ts', import.meta.url));
type Message = {
  event: string;
  outcome?: { status: string };
  metric?: PublicationMetric;
  error?: string;
};
type Mode = 'publish' | 'hold_prepared' | 'hold_committed' | 'sqlite_lock';

class Actor {
  readonly child: ChildProcess;
  readonly messages: Message[] = [];
  #stderr = '';
  constructor(
    substrate: RehearsalSubstrate,
    mode: Mode,
    operationId: string,
    payload: ProbePayload,
  ) {
    if (substrate.verdict.status !== 'isolated' || substrate.sqlitePath === ':memory:') {
      throw new Error('process rehearsal requires an admitted shared file');
    }
    this.child = fork(childPath, [], {
      execArgv: ['--experimental-strip-types', '--import', hookPath],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        PUBLICATION_REHEARSAL_INPUT: JSON.stringify({
          uri: substrate.harness.uri,
          password: substrate.harness.password,
          filePath: substrate.sqlitePath,
          mode,
          operationId,
          payload,
        }),
      },
    });
    this.child.stderr?.on('data', (data: Buffer) => {
      this.#stderr += data.toString();
    });
    this.child.on('message', (message: unknown) => {
      if (message !== null && typeof message === 'object' && 'event' in message) {
        this.messages.push(message as Message);
      }
    });
  }
  send(): void {
    this.child.send('continue');
  }
  async wait(event: string): Promise<Message> {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      const found = this.messages.find((message) => message.event === event);
      if (found !== undefined) {
        return found;
      }
      const failure = this.messages.find((message) => message.event === 'failed');
      if (failure !== undefined || this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(failure?.error ?? `child stopped: ${this.#stderr}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    throw new Error(`waiting for ${event}: ${this.#stderr}`);
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const stopped = new Promise<void>((resolve) => {
      this.child.once('exit', () => {
        resolve();
      });
    });
    this.child.kill('SIGKILL');
    await stopped;
  }
}

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
const cleanup: { store?: SqliteStore } = {};
let coordinator: PublicationCoordinator;
const actors: Actor[] = [];
const metrics: PublicationMetric[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-publication-process-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'shared.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  cleanup.store = store;
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    handlers: [new ProbePublication(), ...PUBLICATION_HANDLERS],
    logger: { warn: () => undefined, error: () => undefined },
    observe: (metric) => {
      metrics.push(metric);
    },
  });
  await coordinator.initialize();
}, 60_000);

afterEach(async () => {
  for (const actor of actors.splice(0)) {
    await actor.stop();
  }
  await coordinator.recover();
});
afterAll(async () => {
  cleanup.store?.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

it.each(['hold_prepared', 'hold_committed'] as const)(
  'recovers a process killed at %s',
  async (mode) => {
    const nodeId = mode;
    const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
    const payload = { nodeId, value: mode, expectedScope, expectedVersion: 0 };
    const checkpoint = await coordinator.checkpoint();
    if (checkpoint.status !== 'ready') {
      throw new Error('fixture checkpoint unavailable');
    }
    const actor = new Actor(substrate, mode, mode, payload);
    actors.push(actor);
    await actor.wait('ready');
    actor.send();
    await actor.wait(mode === 'hold_prepared' ? 'prepared' : 'graph_committed');
    expect(await coordinator.checkpoint()).toMatchObject({
      status: 'unavailable',
      reason: 'pending_publication',
    });
    const completionStarted = performance.now();
    expect(
      await coordinator.completeRead(
        checkpoint.checkpoint,
        async () => true,
        () => {
          throw new Error('pending publication must not persist read effects');
        },
      ),
    ).toEqual({ status: 'retry', reason: 'pending_publication' });
    expect(performance.now() - completionStarted).toBeLessThan(500);
    await actor.stop();
    const recovered = await coordinator.recover();
    expect(recovered).toMatchObject({ status: 'acknowledged', operationId: mode });
    expect((await readPublicationProbe(substrate.harness.driver, nodeId))?.version).toBe(1);
    expect(getLedgerEntry(store.db, `ack:${mode}`)?.summary).toBe(1);
    expect(await coordinator.recover()).toBeUndefined();
  },
  25_000,
);

it('serializes two independent publishers and releases the guard between operations', async () => {
  const scopeA = await seedPublicationProbe(substrate.harness.driver, store.db, 'process-a');
  const scopeB = await seedPublicationProbe(substrate.harness.driver, store.db, 'process-b');
  const a = new Actor(substrate, 'hold_prepared', 'process-a', {
    nodeId: 'process-a',
    value: 'a',
    expectedVersion: 0,
    expectedScope: scopeA,
  });
  actors.push(a);
  await a.wait('ready');
  a.send();
  await a.wait('prepared');
  const b = new Actor(substrate, 'publish', 'process-b', {
    nodeId: 'process-b',
    value: 'b',
    expectedVersion: 0,
    expectedScope: scopeB,
  });
  actors.push(b);
  await b.wait('ready');
  b.send();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 200);
  });
  expect(b.messages.some((message) => message.event === 'done')).toBe(false);
  expect((await readPublicationProbe(substrate.harness.driver, 'process-b'))?.version).toBe(0);
  a.send();
  expect((await a.wait('done')).outcome?.status).toBe('acknowledged');
  expect((await b.wait('done')).outcome?.status).toBe('acknowledged');
  expect(getLedgerEntry(store.db, 'ack:process-a')?.summary).toBe(1);
  expect(getLedgerEntry(store.db, 'ack:process-b')?.summary).toBe(1);
  const bMetrics = b.messages.flatMap((message) =>
    message.metric === undefined ? [] : [message.metric],
  );
  expect(bMetrics.some((metric) => metric.waitMs >= 100)).toBe(true);
  expect(bMetrics.every((metric) => metric.holdMs < 5000)).toBe(true);
  console.log(JSON.stringify({ case: 'parallel-publication', metrics: bMetrics }));
}, 25_000);

it('yields immediately on SQLite contention and releases its graph lock', async () => {
  const nodeId = 'sqlite-busy';
  const expectedScope = await seedPublicationProbe(substrate.harness.driver, store.db, nodeId);
  const payload = { nodeId, value: 'busy', expectedVersion: 0, expectedScope };
  const holder = new Actor(substrate, 'sqlite_lock', 'holder', payload);
  actors.push(holder);
  await holder.wait('locked');
  const timeoutBefore = store.db.pragma('busy_timeout', { simple: true });
  const started = performance.now();
  await expect(
    coordinator.publish({ kind: 'semantic_write', operationId: 'sqlite-busy', payload }),
  ).rejects.toMatchObject({
    reason: 'store_busy',
    retryable: true,
    cause: { code: 'SQLITE_BUSY' },
  });
  const elapsed = performance.now() - started;
  expect(elapsed).toBeLessThan(1500);
  expect(store.db.pragma('busy_timeout', { simple: true })).toBe(timeoutBefore);
  expect(coordinator.hasPending()).toBe(false);
  expect(await coordinator.recover()).toBeUndefined();
  const recent = metrics.at(-1);
  expect(recent?.holdMs).toBeLessThan(1500);
  holder.send();
  await holder.stop();
  expect(
    (await coordinator.publish({ kind: 'semantic_write', operationId: 'sqlite-busy', payload }))
      .status,
  ).toBe('acknowledged');
  console.log(
    JSON.stringify({ case: 'sqlite-busy-yield', elapsedMs: elapsed, releasedLock: recent }),
  );
}, 25_000);
