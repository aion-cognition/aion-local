import type { GraphConnection, Logger, SqliteHandle } from '@aion/core';
import { beforeEach, expect, it, vi, type Mock } from 'vitest';

type Seam = {
  initialize: Mock<() => Promise<void>>;
  publicationArgs: unknown;
  evidenceArgs: unknown;
  coordinator: unknown;
  resolver: unknown;
};
const seam = vi.hoisted<Seam>(() => ({
  initialize: vi.fn<() => Promise<void>>(),
  publicationArgs: undefined,
  evidenceArgs: undefined,
  coordinator: undefined,
  resolver: undefined,
}));
vi.mock('@aion/core', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    PublicationCoordinator: class {
      constructor(args: unknown) {
        seam.publicationArgs = args;
        seam.coordinator = this;
      }
      initialize = seam.initialize;
    },
    EvidenceResolver: class {
      readonly marker = Symbol('resolver');
      constructor(args: unknown) {
        seam.evidenceArgs = args;
        seam.resolver = this;
      }
    },
  };
});
const { lifecycleNarrativeDeps } = await import('./lifecycle.js');
beforeEach(() => {
  seam.initialize.mockReset();
  seam.publicationArgs = undefined;
  seam.evidenceArgs = undefined;
});
const driver = {};
const db = {} as SqliteHandle;
const logger = {} as Logger;
const target = { connection: { driver } as unknown as GraphConnection, db, logger };

it('binds the resolver and coordinator to the same store and waits for initialization', async () => {
  let release = (): void => {
    throw new Error('not initialized');
  };
  seam.initialize.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = lifecycleNarrativeDeps(target);
  expect(seam.evidenceArgs).toBeUndefined();
  release();
  const result = await pending;
  expect(seam.publicationArgs).toMatchObject({ driver, db, logger });
  expect(seam.evidenceArgs).toEqual({ driver, db, logger, publications: seam.coordinator });
  expect(result).toEqual({ resolver: seam.resolver, publications: seam.coordinator });
});

it('propagates initialization refusal without constructing a resolver', async () => {
  const failure = new Error('pairing refused');
  seam.initialize.mockRejectedValue(failure);
  await expect(lifecycleNarrativeDeps(target)).rejects.toBe(failure);
  expect(seam.evidenceArgs).toBeUndefined();
});
