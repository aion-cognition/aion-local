import { describe, expect, it } from 'vitest';

import { GRAPH_MIGRATIONS } from './migrations.js';

const CTX = { embedDimension: 768 };

function statementsOf(version: number): readonly string[] {
  const migration = GRAPH_MIGRATIONS.find((candidate) => candidate.version === version);
  if (migration === undefined) {
    throw new Error(`migration ${version} is not registered`);
  }
  return migration.statements(CTX);
}

describe('the pinned migration list', () => {
  it('is ordered oldest-first with no gaps', () => {
    expect(GRAPH_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('migration 005 substrate identity', () => {
  it('keys the substrate singleton on its id, the way the other backbone labels are keyed', () => {
    expect(statementsOf(5)).toEqual([
      'CREATE CONSTRAINT substrate_id_unique IF NOT EXISTS FOR (n:Substrate) REQUIRE n.id IS UNIQUE',
    ]);
  });
});

describe('migration 004 claim key lookup', () => {
  it('declares the subject and aspect as one composite seek over every memory label', () => {
    const statements = statementsOf(4);

    expect(statements).toEqual([
      'CREATE RANGE INDEX claim_subject_aspect_idx IF NOT EXISTS FOR (n:Memory) ON (n.subject_entity_id, n.aspect_norm)',
    ]);
  });
});

describe('migration 003 identity re-key', () => {
  it('retires the composite constraint before declaring the name-only one', () => {
    const statements = statementsOf(3);
    const drop = statements.findIndex((statement) =>
      statement.includes('DROP CONSTRAINT entity_name_type_unique IF EXISTS'),
    );
    const create = statements.findIndex((statement) =>
      statement.includes('CREATE CONSTRAINT entity_name_unique IF NOT EXISTS'),
    );

    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
    expect(statements[create]).toContain('REQUIRE n.name_norm IS UNIQUE');
  });

  it('indexes the squashed name form without constraining it', () => {
    const statements = statementsOf(3);
    const squash = statements.find((statement) => statement.includes('entity_name_squash_idx'));

    expect(squash).toContain('CREATE INDEX entity_name_squash_idx IF NOT EXISTS');
    expect(squash).toContain('ON (n.name_squash)');
    expect(statements.some((statement) => statement.includes('name_squash IS UNIQUE'))).toBe(false);
  });
});

describe('migration 001', () => {
  it('no longer declares the constraint migration 003 drops, so init stops creating it to drop it', () => {
    expect(statementsOf(1).some((statement) => statement.includes('entity_name_type_unique'))).toBe(
      false,
    );
  });
});
