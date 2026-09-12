import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, expect, it } from 'vitest';

import { durableEligibility } from './eviction-eligibility.js';
import {
  activateCoverage,
  armEviction,
  disarmEviction,
  driver,
  eligibleSource,
  evictionPayload,
  nominateEviction,
  NOW,
  publications,
  store,
  substrateAddress,
  type EvictionNomination,
} from './test-support/a3-eviction.fixture.js';
import { nodeExists } from '../../infrastructure/graph/test-support/a3-eviction-graph.fixture.js';
import { publicationRecord } from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { readSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * Two processes on one receipt, and what survives one of them being killed.
 *
 * An eviction is the operation that most needs this answered. It is the only writer allowed to
 * remove a node, so an attempt interrupted between its graph commit and its acknowledgment leaves
 * a substrate whose graph has already lost the projection and whose records still say it is on its
 * way out. Nothing in one process can prove that window is recoverable across a real crash: the
 * in-process cases throw at a boundary and unwind, which is not what a killed process does to a
 * held Bolt transaction or a SQLite lock.
 *
 * The other half is composition. There is one receipt, so a writer meets whatever is occupying it
 * before it can publish anything of its own, and a command composing a smaller handler set cannot
 * recover an eviction it does not know how to run. That is the refusal the one installed set
 * exists to make impossible for a kind the service does install, and the control here is a second
 * process that composes the small set and fails loudly against a pending eviction.
 */

const childPath = fileURLToPath(
  new URL('./test-support/eviction-process.fixture.ts', import.meta.url),
);
const hookPath = fileURLToPath(
  new URL('../../infrastructure/sqlite/ts-specifier-hook.fixture.ts', import.meta.url),
);

const POLICY = { now: NOW, minAgeMs: 0 };

type Message = {
  readonly event: string;
  readonly outcome?: { readonly status: string; readonly operationId?: string };
  readonly error?: string;
};
type Mode = 'hold_prepared' | 'hold_committed' | 'recover_installed' | 'recover_partial';

class Actor {
  readonly child: ChildProcess;
  readonly messages: Message[] = [];
  #stderr = '';

  constructor(mode: Mode, operationId: string, payload: Record<string, unknown>) {
    const address = substrateAddress();
    if (!address.isolated) {
      throw new Error('process rehearsal requires an admitted shared file');
    }
    this.child = fork(childPath, [], {
      execArgv: ['--experimental-strip-types', '--import', hookPath],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PATH: process.env.PATH,
        EVICTION_REHEARSAL_INPUT: JSON.stringify({
          uri: address.uri,
          password: address.password,
          filePath: address.sqlitePath,
          mode,
          operationId,
          payload,
          now: NOW.toISOString(),
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
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const found = this.messages.find((message) => message.event === event);
      if (found !== undefined) {
        return found;
      }
      const failure = this.messages.find((message) => message.event === 'failed');
      if (failure !== undefined && event !== 'failed') {
        throw new Error(failure.error ?? 'child failed');
      }
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`child stopped before ${event}: ${this.#stderr}`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
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

const actors: Actor[] = [];

function actor(mode: Mode, operationId: string, payload: Record<string, unknown>): Actor {
  const started = new Actor(mode, operationId, payload);
  actors.push(started);
  return started;
}

beforeAll(async () => {
  await activateCoverage();
  await armEviction();
}, 180_000);

afterEach(async () => {
  for (const started of actors.splice(0)) {
    await started.stop();
  }
});

/** One attempt, bound in this process and handed over as the bytes the child publishes. */
async function attempt(
  identity: string,
): Promise<{ readonly sourceId: string; readonly nomination: EvictionNomination }> {
  const sourceId = await eligibleSource(identity, 'S1', true);
  return { sourceId, nomination: await nominateEviction(sourceId, POLICY) };
}

/** Runs the child up to its hold point and kills it there, leaving the receipt where it stood. */
async function killAt(
  mode: 'hold_prepared' | 'hold_committed',
  operationId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const held = actor(mode, operationId, payload);
  await held.wait('ready');
  held.send();
  await held.wait(mode === 'hold_prepared' ? 'prepared' : 'graph_committed');
  // A second process can see the slot occupied, which is the contention: nothing else on this
  // substrate can publish until whatever is there is settled.
  expect((await publications.checkpoint()).status).toBe('unavailable');
  await held.stop();
}

it('lets a second process finish an eviction its writer was killed in the middle of', async () => {
  const { sourceId, nomination } = await attempt('contend-recover');
  const operationId = randomUUID();
  const generationBefore = readSourceResidency(store.db, sourceId)?.projectionGeneration ?? 0;

  await killAt('hold_committed', operationId, evictionPayload(nomination));
  // The graph write landed and the acknowledgment did not, which is the window a receipt exists
  // for: the projection is gone and the records still say the source is on its way out.
  expect(await nodeExists(driver, sourceId)).toBe(false);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('retiring');

  const recovering = actor('recover_installed', operationId, {});
  await recovering.wait('ready');
  recovering.send();
  const finished = await recovering.wait('done');

  expect(finished.outcome).toMatchObject({ status: 'acknowledged', operationId });
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('evicted');
  expect(readSourceResidency(store.db, sourceId)?.projectionGeneration).toBeGreaterThan(
    generationBefore,
  );
  // Exactly once: the receipt is settled, so there is nothing left for anybody to finish.
  expect(await publications.recover()).toBeUndefined();
});

it('resumes an attempt killed before its graph write, from a process that never held it', async () => {
  const { sourceId, nomination } = await attempt('contend-prepared');
  const operationId = randomUUID();

  await killAt('hold_prepared', operationId, evictionPayload(nomination));
  // Nothing was removed yet. The intent is durable, which is what makes the resume possible.
  expect(await nodeExists(driver, sourceId)).toBe(true);

  const recovering = actor('recover_installed', operationId, {});
  await recovering.wait('ready');
  recovering.send();

  expect((await recovering.wait('done')).outcome).toMatchObject({
    status: 'acknowledged',
    operationId,
  });
  expect(await nodeExists(driver, sourceId)).toBe(false);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('evicted');
});

it('refuses loudly in a process that composed a handler set without the eviction', async () => {
  const { sourceId, nomination } = await attempt('contend-partial');
  const operationId = randomUUID();

  await killAt('hold_prepared', operationId, evictionPayload(nomination));

  const partial = actor('recover_partial', operationId, {});
  await partial.wait('ready');
  partial.send();
  const refused = await partial.wait('failed');

  expect(refused.error).toContain('operation_kind_unavailable');
  // It refused rather than dropping the operation, so the receipt is exactly where it was and the
  // composition that does know the kind still finishes it.
  expect(await nodeExists(driver, sourceId)).toBe(true);
  expect((await publications.recover())?.status).toBe('acknowledged');
  expect(await nodeExists(driver, sourceId)).toBe(false);
});

it('stops a killed writer from finishing its removal when the operator disarms', async () => {
  const { sourceId, nomination } = await attempt('contend-disarm');
  const operationId = randomUUID();

  await killAt('hold_prepared', operationId, evictionPayload(nomination));
  // Nothing removed, and a durable pending eviction occupying the receipt. This is the state the
  // operator is trying to act on: the projection is still there and a recovery would take it.
  expect(await nodeExists(driver, sourceId)).toBe(true);

  // The stop, published exactly as `aion evict disarm` publishes it. The guard settles what is
  // pending before it takes this request, so the claim goes down first and the pending eviction
  // meets it at its own recovery re-check.
  await disarmEviction();

  expect(await nodeExists(driver, sourceId)).toBe(true);
  expect(readSourceResidency(store.db, sourceId)?.state).toBe('resident');
  // The pending operation ended, with a receipt that says why rather than being left behind.
  expect(publicationRecord(store.db, operationId)).toMatchObject({
    state: 'deferred',
    error: 'compatibility_disarmed',
  });
  expect(await publications.checkpoint()).toMatchObject({ status: 'ready' });
  expect(durableEligibility(store.db, sourceId, POLICY)).toMatchObject({
    status: 'pinned',
    reason: 'compatibility_disarmed',
  });

  await armEviction();
});
