import type { Driver } from 'neo4j-driver';
import type { SqliteHandle } from '../sqlite/database.js';
import { getMeta, setMeta } from '../sqlite/meta.js';
import { BASE_NODE_LABEL } from './labels.js';
import { CONTENT_FULLTEXT_INDEX } from './seed-queries.js';

/**
 * Backbone nodes (the single Member and the global Workspace) must carry BOTH their
 * structural label (`Member`/`Workspace`) and `Entity`, so the `Entity` composite
 * uniqueness constraint and the `Member.id`/`Workspace.id` constraints all apply to the
 * same node. Every content-bearing memory node (Episode, Turn, and the cognitive types
 * that follow) must carry a shared `Memory` label: Neo4j vector indexes cannot span a
 * label union, so `Memory` is the only way `content_vec_idx`/`context_vec_idx` cover more
 * than one node type. Every node carries `BASE_NODE_LABEL`, which is what gives the
 * type-agnostic id lookups an index to seek. All three are contracts for whoever writes
 * nodes; this migration only declares the schema objects that depend on them.
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
    `CREATE CONSTRAINT aion_node_id_unique IF NOT EXISTS FOR (n:${BASE_NODE_LABEL}) REQUIRE n.id IS UNIQUE`,
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
    // These serve the bounded half of a time-travel filter (`valid_until > t`). An open
    // interval is an absent property, which no Neo4j index covers, so the `IS NULL` half
    // is a scan by construction and every read anchors on a seek before it applies.
    'CREATE RANGE INDEX memory_valid_until_idx IF NOT EXISTS FOR (n:Memory) ON (n.valid_until)',
    'CREATE RANGE INDEX memory_tx_until_idx IF NOT EXISTS FOR (n:Memory) ON (n.tx_until)',
    // Migration 002 owns the fulltext index. It was declared here first, over the three
    // labels that existed then; widening it needed a drop, and a drop that runs on every
    // `aion init` destroys a healthy index and its contents. The name moved instead, so the
    // retirement below is a no-op from the second run onward.
    'DROP INDEX content_fts IF EXISTS',
  ],
};

/**
 * The nine whitepaper §6.7 cognitive types (Goal, Plan, Decision, Insight, Concept,
 * Context, Event, Pattern, Trend) plus Narrative and Bridge — P3's pinned label table.
 * Each gets its own id uniqueness constraint, matching Episode/Turn/Session/Member/
 * Workspace in migration 001; the vector, currency-range, and `Memory`-scoped indexes
 * already declared `FOR (n:Memory)` cover them once `labels.ts`'s `COMPANION_LABELS`
 * carries them into `resolveLabels`, so no per-label index statement is needed here.
 *
 * The fulltext index moves to a new name rather than being dropped and recreated under
 * the old one. `IF NOT EXISTS` cannot redefine an index that already exists, so widening
 * the label set needs a drop — and `runGraphMigrations` replays every statement on every
 * `aion init`, which would make that drop destroy and repopulate a healthy index each time
 * a user reran init. Under a new name both statements are no-ops from the second run on,
 * which is what PRD §11's "touches nothing that is healthy" asks for. The property list is
 * unchanged: `summary` already covers `Narrative.summary` and `text` already covers the
 * cognitive types' text property (canonical name `text` across all nine).
 */
const MIGRATION_002_COGNITIVE_SCHEMA: GraphMigration = {
  version: 2,
  name: 'cognitive node labels, id constraints, fulltext index over every memory label',
  statements: (_ctx) => [
    'CREATE CONSTRAINT narrative_id_unique IF NOT EXISTS FOR (n:Narrative) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT goal_id_unique IF NOT EXISTS FOR (n:Goal) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT plan_id_unique IF NOT EXISTS FOR (n:Plan) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT decision_id_unique IF NOT EXISTS FOR (n:Decision) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT insight_id_unique IF NOT EXISTS FOR (n:Insight) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT concept_id_unique IF NOT EXISTS FOR (n:Concept) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT context_id_unique IF NOT EXISTS FOR (n:Context) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT event_id_unique IF NOT EXISTS FOR (n:Event) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT pattern_id_unique IF NOT EXISTS FOR (n:Pattern) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT trend_id_unique IF NOT EXISTS FOR (n:Trend) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT bridge_id_unique IF NOT EXISTS FOR (n:Bridge) REQUIRE n.id IS UNIQUE',
    `CREATE FULLTEXT INDEX ${CONTENT_FULLTEXT_INDEX} IF NOT EXISTS FOR (n:Episode|Turn|Entity|Narrative|Goal|Plan|Decision|Insight|Concept|Context|Event|Pattern|Trend) ON EACH [n.summary, n.text, n.name]`,
  ],
};

/** Ordered oldest-first; the runner applies whichever versions the meta table has no record of yet. */
export const GRAPH_MIGRATIONS: readonly GraphMigration[] = [
  MIGRATION_001_BACKBONE_SCHEMA,
  MIGRATION_002_COGNITIVE_SCHEMA,
];

const META_KEY_PREFIX = 'graph:migration:';

export function graphMigrationMetaKey(version: number): string {
  return `${META_KEY_PREFIX}${String(version).padStart(3, '0')}`;
}

export type GraphMigrationOutcome = {
  /** Versions recorded in the meta table for the first time on this run. */
  readonly applied: readonly number[];
  /** Schema objects this run actually created, empty when the graph was already whole. */
  readonly created: readonly string[];
};

async function schemaObjectNames(driver: Driver): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const statement of ['SHOW CONSTRAINTS YIELD name RETURN name', 'SHOW INDEXES YIELD name RETURN name']) {
    const result = await driver.executeQuery(statement);
    for (const record of result.records) {
      names.add(record.get('name') as string);
    }
  }
  return [...names].sort();
}

/**
 * Runs every migration's statements on every call, in version order. The statements are
 * independently idempotent (`IF NOT EXISTS`), and the graph lives on a different volume
 * from the SQLite meta table, so the meta row records first application rather than
 * gating the run: a graph volume reset on its own has to be repaired by the next init,
 * not skipped because SQLite still remembers the migration.
 */
export async function runGraphMigrations(
  driver: Driver,
  db: SqliteHandle,
  ctx: MigrationContext,
): Promise<GraphMigrationOutcome> {
  const before = new Set(await schemaObjectNames(driver));
  const applied: number[] = [];

  for (const migration of GRAPH_MIGRATIONS) {
    for (const statement of migration.statements(ctx)) {
      await driver.executeQuery(statement);
    }

    const key = graphMigrationMetaKey(migration.version);
    if (getMeta(db, key) === undefined) {
      setMeta(db, key, new Date().toISOString());
      applied.push(migration.version);
    }
  }

  const created = (await schemaObjectNames(driver)).filter((name) => !before.has(name));
  return { applied, created };
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
