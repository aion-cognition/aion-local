import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';

/**
 * The revision and generation tables as they looked before the coverage payload, the retry
 * columns and the operational counter existed. A substrate carrying rows in this shape is what
 * the column additions have to reach, and the pragma comparison below is what says they reach
 * the same table a fresh file gets.
 */

type TableRow = { name: string };

function tableNames(store: SqliteStore): string[] {
  return store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as TableRow).name)
    .sort();
}

/** Every table's columns and indexes as the pragmas report them, which is the shape comparison. */

describe('the identity schema bootstrap', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-identity-schema-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(name: string): SqliteStore {
    return new SqliteStore({ filePath: join(dir, name) });
  }

  it('creates every identity, narrative, publication and readiness table', () => {
    const store = open('fresh.sqlite');
    try {
      expect(tableNames(store)).toEqual(
        expect.arrayContaining([
          'chunk_members',
          'chunk_revisions',
          'chunks',
          'coverage_contract',
          'eviction_manifests',
          'evidence_acknowledgments',
          'evidence_link_versions',
          'evidence_links',
          'evidence_scope_mirrors',
          'evidence_scope_versions',
          'family_selection_log',
          'ingest_log',
          'orphan_observations',
          'overview_registry',
          'overview_revisions',
          'publication_control',
          'publication_effects',
          'publication_intents',
          'readiness_policies',
          'revision_citations',
          'revision_dependencies',
          'session_remainders',
          'source_incidence',
          'source_parts',
          'source_processing_generations',
          'source_records',
          'source_reference_batches',
          'source_residency',
          'source_state_versions',
          'source_work',
        ]),
      );
    } finally {
      store.close();
    }
  });

  it('refuses a negative attempt count and a negative operational revision', () => {
    const store = open('fresh.sqlite');
    try {
      store.db
        .prepare(
          `INSERT INTO source_processing_generations
             (source_id, processing_generation, policy_revision, state, created_at)
           VALUES ('source-1', 1, 1, 'active', '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO chunk_revisions (chunk_id, revision_no, node_id, state, allocated_at)
           VALUES ('chunk-1', 1, 'node-1', 'allocated', '2026-09-01T00:00:00.000Z')`,
        )
        .run();
      store.db
        .prepare(
          `INSERT INTO overview_revisions (family_key, revision_no, node_id, state, allocated_at)
           VALUES ('calendar:2026-W36', 1, 'node-2', 'allocated', '2026-09-01T00:00:00.000Z')`,
        )
        .run();

      expect(() =>
        store.db
          .prepare('UPDATE source_processing_generations SET operational_revision = -1')
          .run(),
      ).toThrow(/CHECK constraint failed/);
      for (const table of ['chunk_revisions', 'overview_revisions']) {
        expect(() => store.db.prepare(`UPDATE ${table} SET attempts = -1`).run()).toThrow(
          /CHECK constraint failed/,
        );
      }
    } finally {
      store.close();
    }
  });

  it('rejects a verified source record that carries only part of its archive proof', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO source_records
           (source_id, session_id, canonical_archive_id, archive_schema_version, identity_hash,
            verified_content_digest, verification_policy_version, verification_status,
            occurred_at, archived_at, created_at)
         VALUES (?, 'session-1', ?, ?, ?, ?, ?, 'verified', '2026-09-01T00:00:00.000Z', ?, '2026-09-01T00:00:00.000Z')`,
      );
      expect(() =>
        insert.run(
          'half-proved',
          'archive-1',
          3,
          'identity-1',
          null,
          1,
          '2026-09-01T00:00:00.000Z',
        ),
      ).toThrow(/CHECK constraint failed/);
      insert.run('proved', 'archive-1', 3, 'identity-1', 'digest-1', 1, '2026-09-01T00:00:00.000Z');
      expect(store.db.prepare('SELECT count(*) AS n FROM source_records').get()).toEqual({ n: 1 });
    } finally {
      store.close();
    }
  });

  it('inserts a graph-only pin with no archive fields at all', () => {
    const store = open('fresh.sqlite');
    try {
      store.db
        .prepare(
          `INSERT INTO source_records
             (source_id, session_id, verification_status, verification_reason, occurred_at, created_at)
           VALUES ('graph-only', 'session-1', 'pinned', 'no archive row', ?, ?)`,
        )
        .run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');

      expect(
        store.db
          .prepare(
            'SELECT canonical_archive_id, archived_at FROM source_records WHERE source_id = ?',
          )
          .get('graph-only'),
      ).toEqual({ canonical_archive_id: null, archived_at: null });
    } finally {
      store.close();
    }
  });

  it('keeps two parts with no turn id apart and rejects a repeated turn id', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO source_parts (source_id, part_kind, ordinal, turn_id, content_hash)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run('source-1', 'observation', 0, null, 'hash-a');
      insert.run('source-1', 'observation', 1, null, 'hash-b');
      insert.run('source-1', 'turn', 0, 'turn-1', 'hash-c');

      expect(() => insert.run('source-2', 'turn', 0, 'turn-1', 'hash-d')).toThrow(/UNIQUE/);
      expect(store.db.prepare('SELECT count(*) AS n FROM source_parts').get()).toEqual({ n: 3 });
    } finally {
      store.close();
    }
  });

  it('refuses to seal one source into a second chunk', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        'INSERT INTO chunk_members (chunk_id, source_id, member_ordinal) VALUES (?, ?, ?)',
      );
      insert.run('chunk-a', 'source-1', 0);

      expect(() => insert.run('chunk-b', 'source-1', 0)).toThrow(/UNIQUE/);
      // The ordinal is unique inside a chunk too.
      insert.run('chunk-a', 'source-2', 1);
      expect(() => insert.run('chunk-a', 'source-3', 1)).toThrow(/UNIQUE/);
    } finally {
      store.close();
    }
  });

  it('rejects a second active generation for one source and takes one after a replacement', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO source_processing_generations
           (source_id, processing_generation, policy_revision, state, created_at)
         VALUES (?, ?, 1, ?, '2026-09-01T00:00:00.000Z')`,
      );
      insert.run('source-1', 1, 'active');

      expect(() => insert.run('source-1', 2, 'active')).toThrow(/UNIQUE/);

      store.db
        .prepare(
          `UPDATE source_processing_generations SET state = 'replaced'
           WHERE source_id = 'source-1' AND processing_generation = 1`,
        )
        .run();
      insert.run('source-1', 2, 'active');

      expect(
        store.db
          .prepare(
            `SELECT processing_generation FROM source_processing_generations
             WHERE source_id = 'source-1' AND state = 'active'`,
          )
          .all(),
      ).toEqual([{ processing_generation: 2 }]);
    } finally {
      store.close();
    }
  });

  it('rejects a duplicate obligation, an unknown work state and a runnable row with no due time', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, stage_name, work_key, state, due_at)
         VALUES (?, 'source-1', 1, ?, ?, ?, ?, ?)`,
      );
      insert.run(
        'work-1',
        'stage',
        'enrich',
        'stage:enrich',
        'pending',
        '2026-09-01T00:00:00.000Z',
      );

      expect(() =>
        insert.run(
          'work-2',
          'stage',
          'enrich',
          'stage:enrich',
          'pending',
          '2026-09-01T00:00:00.000Z',
        ),
      ).toThrow(/UNIQUE/);
      expect(() =>
        insert.run(
          'work-3',
          'stage',
          'enrich',
          'stage:other',
          'invented',
          '2026-09-01T00:00:00.000Z',
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() => insert.run('work-4', 'stage', 'enrich', 'stage:other', 'pending', null)).toThrow(
        /CHECK constraint failed/,
      );
      expect(() =>
        insert.run('work-5', 'stage', null, 'stage:other', 'pending', '2026-09-01T00:00:00.000Z'),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      store.close();
    }
  });

  it('refuses a completed stage that records no outcome', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO source_work
           (work_id, source_id, processing_generation, kind, stage_name, work_key, state,
            outcome_json, completed_at)
         VALUES (?, 'source-1', 1, 'stage', 'enrich', ?, 'completed', ?, ?)`,
      );
      expect(() => insert.run('work-1', 'stage:enrich', null, '2026-09-01T00:00:00.000Z')).toThrow(
        /CHECK constraint failed/,
      );
      insert.run(
        'work-2',
        'stage:enrich',
        '{"outcome":"not_applicable","reason":"no attachments"}',
        '2026-09-01T00:00:00.000Z',
      );
      expect(
        store.db.prepare('SELECT outcome_json FROM source_work WHERE work_id = ?').get('work-2'),
      ).toEqual({ outcome_json: '{"outcome":"not_applicable","reason":"no attachments"}' });
    } finally {
      store.close();
    }
  });

  it('refuses a coverage row that claims history without a boundary', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO coverage_contract
           (epoch, history_since, activated_at, field_policy_version, state)
         VALUES (?, ?, ?, 1, ?)`,
      );
      expect(() => insert.run('epoch-1', null, null, 'active')).toThrow(/CHECK constraint failed/);
      expect(() => insert.run('epoch-1', '2026-01-01T00:00:00.000Z', null, 'preparing')).toThrow(
        /CHECK constraint failed/,
      );

      insert.run('epoch-1', null, null, 'preparing');
      insert.run('epoch-2', '2026-01-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'active');

      // The wire version is the same on both rows: adding a revision is not a wire change.
      expect(
        store.db
          .prepare('SELECT registry_revision, contract_version, state FROM coverage_contract')
          .all(),
      ).toEqual([
        { registry_revision: 1, contract_version: 1, state: 'preparing' },
        { registry_revision: 2, contract_version: 1, state: 'active' },
      ]);
    } finally {
      store.close();
    }
  });

  it('refuses an acknowledged publication that carries no result', () => {
    const store = open('fresh.sqlite');
    try {
      const insert = store.db.prepare(
        `INSERT INTO publication_intents
           (operation_id, kind, payload_digest, payload_json, affected_scopes_json, expected_json,
            prepared_actions_json, state, result_digest, result_json, known_from, observed_ack_at,
            created_at)
         VALUES (?, 'intake', 'digest', '{}', '[]', '{}', '[]', 'acknowledged', ?, ?, ?, ?, ?)`,
      );
      const now = '2026-09-01T00:00:00.000Z';
      expect(() => insert.run('op-1', 'result-digest', null, now, now, now)).toThrow(
        /CHECK constraint failed/,
      );
      insert.run('op-2', 'result-digest', '{"published":true}', now, now, now);
      expect(
        store.db
          .prepare('SELECT sequence FROM publication_intents WHERE operation_id = ?')
          .get('op-2'),
      ).toEqual({ sequence: 1 });
    } finally {
      store.close();
    }
  });
});
