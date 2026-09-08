import { describe, expect, it } from 'vitest';

import {
  IN_MEMORY_SQLITE,
  checkRehearsalTarget,
  type SubstrateTarget,
  type TargetDeclaration,
} from './campaign-isolation.js';

const PRODUCTION: SubstrateTarget = {
  graphUri: 'bolt://localhost:7687',
  sqlitePath: '/data/aion.sqlite',
};

const HARNESS: TargetDeclaration = { kind: 'harness', containerName: 'aion-test-neo4j-abc' };

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

  it('refuses a relative substrate path, which names no root to compare', () => {
    expect(
      checkRehearsalTarget({
        target: disposable({ sqlitePath: 'aion.sqlite' }),
        production: PRODUCTION,
        declaration: HARNESS,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'production_data_root' });
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

  it('refuses a harness declaration that names no container', () => {
    expect(
      checkRehearsalTarget({
        target: disposable(),
        production: PRODUCTION,
        declaration: { kind: 'harness', containerName: '  ' },
      }),
    ).toMatchObject({ status: 'rejected', reason: 'unverified_target' });
  });
});
