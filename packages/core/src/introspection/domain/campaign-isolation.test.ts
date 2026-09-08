import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IN_MEMORY_SQLITE,
  canonicalPath,
  checkRehearsalTarget,
  dataRootVerdict,
  type SubstrateTarget,
  type TargetDeclaration,
} from './campaign-isolation.js';

const PRODUCTION: SubstrateTarget = {
  graphUri: 'bolt://localhost:7687',
  sqlitePath: '/data/aion.sqlite',
};

const HARNESS: TargetDeclaration = {
  kind: 'harness',
  containerName: 'aion-test-neo4j-abc',
  createdByThisRun: true,
};

function disposable(overrides: Partial<SubstrateTarget> = {}): SubstrateTarget {
  return { graphUri: 'bolt://localhost:7999', sqlitePath: IN_MEMORY_SQLITE, ...overrides };
}

describe('admitting a rehearsal target', () => {
  it('accepts a container this run started', () => {
    expect(
      checkRehearsalTarget({
        target: disposable(),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toEqual({ status: 'isolated', basis: 'harness_created' });
  });

  it('accepts a clone whose stated identity matches what it connects to', () => {
    const target = disposable({ sqlitePath: '/tmp/clone/aion.sqlite' });
    expect(
      checkRehearsalTarget({
        target,
        production: PRODUCTION,
        declaration: {
          kind: 'declared_clone',
          verifiedGraphUri: target.graphUri,
          verifiedSqlitePath: target.sqlitePath,
        },
      }),
    ).toEqual({ status: 'isolated', basis: 'verified_clone' });
  });
});

describe('refusing a rehearsal target', () => {
  it('refuses a substrate nobody declared', () => {
    expect(checkRehearsalTarget({ target: disposable(), production: PRODUCTION })).toMatchObject({
      status: 'rejected',
      reason: 'undeclared_target',
    });
  });

  it('refuses the running graph endpoint', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ graphUri: 'bolt://localhost:7687' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_graph_endpoint' });
  });

  it('refuses the running endpoint spelled a different way', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ graphUri: 'BOLT://127.0.0.1:7687/' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_graph_endpoint' });
  });

  it('refuses the running endpoint written without its default port', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ graphUri: 'bolt://localhost' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_graph_endpoint' });
  });

  it('refuses the running substrate file', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ sqlitePath: '/data/aion.sqlite' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_data_root' });
  });

  it('refuses a file that shares the running substrate directory', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ sqlitePath: '/data/rehearsal.sqlite' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_data_root' });
  });

  it('refuses a relative substrate path, whose identity nothing can resolve', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ sqlitePath: 'aion.sqlite' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'unverified_target' });
  });

  it('refuses a clone whose stated endpoint is not the one it connects to', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ sqlitePath: '/tmp/clone/aion.sqlite' }),
        production: PRODUCTION,
        declaration: {
          kind: 'declared_clone',
          verifiedGraphUri: 'bolt://localhost:7998',
          verifiedSqlitePath: '/tmp/clone/aion.sqlite',
        },
      }),
    ).toMatchObject({ status: 'rejected', reason: 'unverified_target' });
  });

  it('refuses a container this run did not create', () => {
    expect(
      checkRehearsalTarget({
        target: disposable(),
        production: PRODUCTION,
        declaration: { kind: 'harness', containerName: 'someone-elses', createdByThisRun: false },
      }),
    ).toMatchObject({ status: 'rejected', reason: 'unverified_target' });
  });

  it('treats a routing-scheme alias of the running endpoint as the running endpoint', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ graphUri: 'neo4j://localhost:7687' }),
        production: { graphUri: 'bolt://127.0.0.1:7687', sqlitePath: '/data/aion.sqlite' },
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_graph_endpoint' });
  });

  it('refuses a running file that sits inside the rehearsal directory', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ sqlitePath: '/tmp/clone/aion.sqlite' }),
        production: { graphUri: 'bolt://neo4j:7687', sqlitePath: '/tmp/clone/nested/live.sqlite' },
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_data_root' });
  });

  it('refuses a harness declaration that names no container', () => {
    expect(
      checkRehearsalTarget({
        target: disposable(),
        production: PRODUCTION,
        declaration: { kind: 'harness', containerName: '  ', createdByThisRun: true },
      }),
    ).toMatchObject({ status: 'rejected', reason: 'unverified_target' });
  });
});

describe('resolving a path to a filesystem identity', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-isolation-paths-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows a symlink to the directory it actually names', () => {
    const real = join(dir, 'production');
    mkdirSync(real);
    writeFileSync(join(real, 'aion.sqlite'), 'fixture');
    symlinkSync(real, join(dir, 'alias'));

    expect(canonicalPath(join(dir, 'alias', 'aion.sqlite'))).toBe(
      canonicalPath(join(real, 'aion.sqlite')),
    );
    expect(dataRootVerdict(join(dir, 'alias', 'aion.sqlite'), join(real, 'aion.sqlite'))).toBe(
      'overlapping',
    );
  });

  it('resolves a target that does not exist yet through its existing parent', () => {
    const real = join(dir, 'production');
    mkdirSync(real);
    symlinkSync(real, join(dir, 'alias'));

    expect(canonicalPath(join(dir, 'alias', 'not-created-yet.sqlite'))).toBe(
      join(canonicalPath(real) ?? '', 'not-created-yet.sqlite'),
    );
  });

  it('resolves nothing for a path that names no root', () => {
    expect(canonicalPath('aion.sqlite')).toBe(undefined);
    expect(dataRootVerdict('aion.sqlite', '/data/aion.sqlite')).toBe('unresolvable');
  });

  it('leaves the in-memory substrate as itself', () => {
    expect(canonicalPath(IN_MEMORY_SQLITE)).toBe(IN_MEMORY_SQLITE);
    expect(dataRootVerdict(IN_MEMORY_SQLITE, '/data/aion.sqlite')).toBe('distinct');
  });
});
