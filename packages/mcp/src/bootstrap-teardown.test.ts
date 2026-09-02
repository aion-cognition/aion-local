import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A failure partway through `bootstrapService` has to stop whichever background component
 * already started before it closes the driver and the store, the same way a normal shutdown
 * does. A real Neo4j and a real pipeline cannot isolate that ordering from everything else the
 * service does, so every dependency here is a fake that records when it was torn down.
 */

const calls = vi.hoisted(() => [] as string[]);

vi.mock('@aion/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  class FakeGraphConnection {
    readonly uri = 'bolt://fake';
    readonly driver = {};
    async health(): Promise<{ reachable: true }> {
      return { reachable: true };
    }
    async close(): Promise<void> {
      calls.push('connection.close');
    }
  }
  class FakeSqliteStore {
    readonly db = {};
    close(): void {
      calls.push('store.close');
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- constructed structurally, mirroring the real class this stands in for.
  class FakeSessionManager {}
  class FakeProviderRouter {
    readonly routing = { roles: {} };
    forRole(): unknown {
      return {};
    }
  }
  class FakeRecallSideEffects {
    onRecalled(): void {
      // Not exercised: nothing here calls handleRecall.
    }
    async whenIdle(): Promise<void> {
      calls.push('sideEffects.whenIdle');
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- constructed structurally, mirroring the real class this stands in for.
  class FakeReflectionOrchestrator {}
  class FakeReflectionWorker {
    async start(): Promise<void> {
      calls.push('worker.start');
    }
    async stop(): Promise<void> {
      calls.push('worker.stop');
    }
    wake(): void {
      // Not exercised: the fake pipeline enqueues nothing.
    }
  }
  class FakeIdleNarrativeSweeper {
    readonly intervalMs = 1000;
    start(): void {
      calls.push('idleNarratives.start');
    }
    async stop(): Promise<void> {
      calls.push('idleNarratives.stop');
    }
  }
  class FakeSessionNarrativeCloser {
    onSessionClosed(): void {
      // Not exercised: no session ever closes in this test.
    }
    async whenIdle(): Promise<void> {
      calls.push('narratives.whenIdle');
    }
  }
  class FakeIntrospector {
    readonly tickMs = 1000;
    start(): void {
      calls.push('introspector.start');
    }
    async stop(): Promise<void> {
      calls.push('introspector.stop');
    }
  }
  return {
    ...actual,
    loadConfig: () => actual.DEFAULTS,
    openLogger: () => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: () => undefined,
    }),
    GraphConnection: FakeGraphConnection,
    SqliteStore: FakeSqliteStore,
    SessionManager: FakeSessionManager,
    ProviderRouter: FakeProviderRouter,
    RecallSideEffects: FakeRecallSideEffects,
    ReflectionOrchestrator: FakeReflectionOrchestrator,
    ReflectionWorker: FakeReflectionWorker,
    IdleNarrativeSweeper: FakeIdleNarrativeSweeper,
    SessionNarrativeCloser: FakeSessionNarrativeCloser,
    Introspector: FakeIntrospector,
    reflectionStages: () => [],
    introspectionOperations: () => [],
    unbackedPins: () => [],
    routingSummary: () => 'fake routing',
    modelAdvisor: () => ({}),
    bootstrapBackbone: async () => ({
      member: { id: 'member-1' },
      workspace: { id: 'workspace-1' },
    }),
    readMemberName: async () => 'member-1',
    latestAppliedGraphMigration: () => 'migration-1',
    reconcileResidentModels: async () => ({ checked: false }),
  };
});

// The one failure this suite forces: everything up to the service itself starts, and the
// service's own construction is what throws.
vi.mock('./service.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- exists only to throw on construction.
  AionMcpService: class {
    constructor() {
      throw new Error('service construction boom');
    }
  },
}));

const { bootstrapService } = await import('./bootstrap.js');

beforeEach(() => {
  calls.length = 0;
});

describe('bootstrapService failing partway through construction', () => {
  it('stops every component that already started, in the same order a normal close does', async () => {
    await expect(bootstrapService({})).rejects.toThrow('service construction boom');

    // The fake pipeline has no stages, so `worker.start` is never called (only logged as
    // idle); `worker.stop` still runs in teardown, since the worker was still constructed.
    expect(calls).toEqual([
      'idleNarratives.start',
      'introspector.start',
      'introspector.stop',
      'narratives.whenIdle',
      'sideEffects.whenIdle',
      'idleNarratives.stop',
      'worker.stop',
      'connection.close',
      'store.close',
    ]);
  });
});
