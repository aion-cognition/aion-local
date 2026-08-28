import type { Driver } from 'neo4j-driver';
import type { SqliteHandle } from '../sqlite/database.js';
import { getMeta, setMeta } from '../sqlite/meta.js';

/**
 * Backbone nodes (the single Member and the global Workspace, P0-8) must carry BOTH
 * their structural label (`Member`/`Workspace`) and `Entity`, so the `Entity` composite
 * uniqueness constraint and the `Member.id`/`Workspace.id` constraints all apply to the
 * same node. Every content-bearing memory node (Episode, Turn, and cognitive types from
 * P3 on) must carry a shared `Memory` label: Neo4j vector indexes cannot span a label
 * union, so `Memory` is the only way `content_vec_idx`/`context_vec_idx` cover more than
 * one node type. Both rules are contracts for whoever writes nodes (P0-7 helpers, P0-8
 * bootstrap); this migration only declares the schema objects that depend on them.
 */
export type MigrationContext = {
  embedDimension: number;
};

export type GraphMigration = {
  readonly version: number;
  readonly name: string;
  statements(ctx: MigrationContext): readonly string[];
};

const MIGRATION_001_BACKBONE_SCHEMA: GraphMigration = {
  version: 1,
  name: 'backbone constraints, memory vector/range indexes, fulltext',
  statements: (ctx) => [
    'CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (n:Session) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT episode_id_unique IF NOT EXISTS FOR (n:Episode) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT turn_id_unique IF NOT EXISTS FOR (n:Turn) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT entity_name_type_unique IF NOT EXISTS FOR (n:Entity) REQUIRE (n.name_norm, n.type) IS UNIQUE',
    'CREATE CONSTRAINT member_id_unique IF NOT EXISTS FOR (n:Member) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT workspace_id_unique IF NOT EXISTS FOR (n:Workspace) REQUIRE n.id IS UNIQUE',
    `CREATE VECTOR INDEX content_vec_idx IF NOT EXISTS FOR (n:Memory) ON (n.content_vec)
     OPTIONS { indexConfig: { \`vector.dimensions\`: ${ctx.embedDimension}, \`vector.similarity_function\`: 'cosine' } }`,
    `CREATE VECTOR INDEX context_vec_idx IF NOT EXISTS FOR (n:Memory) ON (n.context_vec)
     OPTIONS { indexConfig: { \`vector.dimensions\`: ${ctx.embedDimension}, \`vector.similarity_function\`: 'cosine' } }`,
    'CREATE RANGE INDEX memory_valid_until_idx IF NOT EXISTS FOR (n:Memory) ON (n.valid_until)',
    'CREATE RANGE INDEX memory_tx_until_idx IF NOT EXISTS FOR (n:Memory) ON (n.tx_until)',
    'CREATE FULLTEXT INDEX content_fts IF NOT EXISTS FOR (n:Episode|Turn|Entity) ON EACH [n.summary, n.text, n.name]',
  ],
};

/** Ordered oldest-first; the runner applies whichever versions the meta table has no record of yet. */
export const GRAPH_MIGRATIONS: readonly GraphMigration[] = [MIGRATION_001_BACKBONE_SCHEMA];

const META_KEY_PREFIX = 'graph:migration:';

export function graphMigrationMetaKey(version: number): string {
  return `${META_KEY_PREFIX}${String(version).padStart(3, '0')}`;
}

/**
 * Applies every migration the SQLite meta table has no record of, in version order, then
 * records each as applied. Each statement is also independently idempotent (`IF NOT
 * EXISTS`), so a crash between a migration's Neo4j writes and its meta-table record
 * still converges to the same end state on the next run rather than erroring.
 */
export async function runGraphMigrations(
  driver: Driver,
  db: SqliteHandle,
  ctx: MigrationContext,
): Promise<{ applied: readonly number[] }> {
  const applied: number[] = [];

  for (const migration of GRAPH_MIGRATIONS) {
    const key = graphMigrationMetaKey(migration.version);
    if (getMeta(db, key) !== undefined) {
      continue;
    }

    for (const statement of migration.statements(ctx)) {
      await driver.executeQuery(statement);
    }

    setMeta(db, key, new Date().toISOString());
    applied.push(migration.version);
  }

  return { applied };
}

/** Highest migration version recorded as applied, or undefined if none has run yet. Used by `aion doctor`'s schema-version check. */
export function latestAppliedGraphMigration(db: SqliteHandle): number | undefined {
  let latest: number | undefined;

  for (const migration of GRAPH_MIGRATIONS) {
    if (getMeta(db, graphMigrationMetaKey(migration.version)) !== undefined) {
      latest = migration.version;
    }
  }

  return latest;
}
