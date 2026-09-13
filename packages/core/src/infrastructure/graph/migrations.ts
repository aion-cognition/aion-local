import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { CONTEXT_VECTOR_PROPERTY } from './context-vector-queries.js';
import { ENTITY_NAME_SQUASH_PROPERTY } from './entity-identity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, MEMORY_LABEL } from './labels.js';
import { PUBLICATION_GUARD_CONSTRAINT_STATEMENT } from './publication-guard.js';
import {
  CONTENT_FULLTEXT_INDEX,
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
} from './seed-queries.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../reflection/domain/claim-key.js';
import type { SqliteHandle } from '../sqlite/database.js';
import { getMeta, setMeta } from '../sqlite/meta.js';

/**
 * The graph schema, declared once.
 *
 * Three label contracts hold every statement below together, and they are contracts for whoever
 * writes nodes rather than anything this file can enforce. Backbone nodes (the single Member, the
 * global Workspace and the Substrate) carry BOTH their structural label and `Entity`, so the
 * `Entity` name uniqueness rule and the per-label id rules apply to the same node. Every
 * content-bearing memory node carries `Memory`: Neo4j vector indexes cannot span a label union, so
 * that shared label is the only way `content_vec_idx` and `context_vec_idx` cover more than one
 * node type. Every node carries `BASE_NODE_LABEL`, which is what gives the type-agnostic id
 * lookups an index to seek.
 *
 * Entity identity is keyed on the name alone. `type` is a reconciled label backed by counted
 * observations rather than half of the key: the extractor is unstable in the type it picks, so a
 * composite key forked one referent into a tool node and a topic node and every pair the merge
 * queue then surfaced was of its own making. `name_squash` gets a plain index and not a
 * constraint, because separator variants are duplicate evidence for the dedup cascade to weigh
 * rather than a uniqueness rule the write path has to satisfy.
 */
export type GraphSchemaContext = {
  embedDimension: number;
};

/** The version this build declares. It moves when the statements below change. */
export const GRAPH_SCHEMA_VERSION = 7;

export function graphSchemaStatements(ctx: GraphSchemaContext): readonly string[] {
  return [
    `CREATE CONSTRAINT aion_node_id_unique IF NOT EXISTS FOR (n:${BASE_NODE_LABEL}) REQUIRE n.id IS UNIQUE`,
    'CREATE CONSTRAINT session_id_unique IF NOT EXISTS FOR (n:Session) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT episode_id_unique IF NOT EXISTS FOR (n:Episode) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT turn_id_unique IF NOT EXISTS FOR (n:Turn) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT member_id_unique IF NOT EXISTS FOR (n:Member) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT workspace_id_unique IF NOT EXISTS FOR (n:Workspace) REQUIRE n.id IS UNIQUE',
    // The substrate's own identity node, keyed the way the Member and the global Workspace are:
    // the singleton resolution that mints an id has a uniqueness rule behind it. It carries
    // `Entity` too, which puts its name under `entity_name_unique`.
    'CREATE CONSTRAINT substrate_id_unique IF NOT EXISTS FOR (n:Substrate) REQUIRE n.id IS UNIQUE',
    `CREATE CONSTRAINT entity_name_unique IF NOT EXISTS FOR (n:Entity) REQUIRE n.${ENTITY_NAME_NORM_PROPERTY} IS UNIQUE`,
    // The nine cognitive types, plus Narrative and Bridge: the pinned label table, each with its
    // own id rule. The vector, currency and `Memory`-scoped indexes below cover them once
    // `labels.ts`'s `COMPANION_LABELS` carries them into `resolveLabels`.
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
    // The uniqueness rule behind the publication guard, declared before any coordinator can use
    // one. Only the rule belongs here: the guard node itself is created under the substrate's
    // bootstrap marker, so a guard that goes missing afterwards is reported rather than silently
    // replaced (`publication-guard.ts`).
    PUBLICATION_GUARD_CONSTRAINT_STATEMENT,
    `CREATE VECTOR INDEX content_vec_idx IF NOT EXISTS FOR (n:${MEMORY_LABEL}) ON (n.${MEMORY_PROPERTIES.contentVector})
     OPTIONS { indexConfig: { \`vector.dimensions\`: ${ctx.embedDimension}, \`vector.similarity_function\`: 'cosine' } }`,
    `CREATE VECTOR INDEX context_vec_idx IF NOT EXISTS FOR (n:${MEMORY_LABEL}) ON (n.${CONTEXT_VECTOR_PROPERTY})
     OPTIONS { indexConfig: { \`vector.dimensions\`: ${ctx.embedDimension}, \`vector.similarity_function\`: 'cosine' } }`,
    // These serve the bounded half of a time-travel filter (`valid_until > t`). An open interval
    // is an absent property, which no Neo4j index covers, so the `IS NULL` half is a scan by
    // construction and every read anchors on a seek before it applies.
    `CREATE RANGE INDEX memory_valid_until_idx IF NOT EXISTS FOR (n:${MEMORY_LABEL}) ON (n.${BITEMPORAL_PROPERTIES.validUntil})`,
    `CREATE RANGE INDEX memory_tx_until_idx IF NOT EXISTS FOR (n:${MEMORY_LABEL}) ON (n.${BITEMPORAL_PROPERTIES.txUntil})`,
    `CREATE INDEX entity_name_squash_idx IF NOT EXISTS FOR (n:Entity) ON (n.${ENTITY_NAME_SQUASH_PROPERTY})`,
    // The seek behind the subject-keyed claim lookup: a claim about to be written asks which open
    // claim already asserts the same attribute of the same subject, and a scan for that answer
    // would run on every fact-bearing write. Scoped to `Memory` for the reason the vector and
    // currency indexes are, with the four fact-bearing labels a post-filter over the handful of
    // rows the composite seek returns.
    `CREATE RANGE INDEX claim_subject_aspect_idx IF NOT EXISTS FOR (n:${MEMORY_LABEL}) ON (n.${CLAIM_SUBJECT_PROPERTY}, n.${CLAIM_ASPECT_PROPERTY})`,
    // One fulltext index over every content-bearing label. `summary` covers `Narrative.summary`
    // and `text` covers the cognitive types' text property. `Bridge` carries `Memory` and holds
    // text and is still left out: a bridge's text is a sentence the introspection loop generated
    // about two communities, so a keyword hit on it answers with the substrate's own connector
    // rather than with anything a person said. Its content vector puts it in `content_vec_idx`,
    // and spreading activation reaches it from either endpoint it joins.
    `CREATE FULLTEXT INDEX ${CONTENT_FULLTEXT_INDEX} IF NOT EXISTS FOR (n:Episode|Turn|Entity|Narrative|Goal|Plan|Decision|Insight|Concept|Context|Event|Pattern|Trend) ON EACH [n.${MEMORY_PROPERTIES.summary}, n.${MEMORY_PROPERTIES.text}, n.${ENTITY_NAME_PROPERTY}]`,
  ];
}

const SCHEMA_META_KEY = 'graph:schema_version';

export type GraphSchemaOutcome = {
  /** True when this run recorded the version for the first time. */
  readonly applied: boolean;
  /** Schema objects this run actually created, empty when the graph was already whole. */
  readonly created: readonly string[];
};

async function schemaObjectNames(driver: Driver): Promise<readonly string[]> {
  const names = new Set<string>();
  for (const statement of [
    'SHOW CONSTRAINTS YIELD name RETURN name',
    'SHOW INDEXES YIELD name RETURN name',
  ]) {
    const result = await driver.executeQuery(statement);
    for (const record of result.records) {
      names.add(record.get('name') as string);
    }
  }
  return [...names].sort();
}

/**
 * Runs every statement on every call.
 *
 * They are independently idempotent (`IF NOT EXISTS`), and the graph lives on a different volume
 * from the SQLite meta table, so the meta row records first application rather than gating the
 * run: a graph volume reset on its own has to be repaired by the next init, not skipped because
 * SQLite still remembers it.
 */
export async function runGraphMigrations(
  driver: Driver,
  db: SqliteHandle,
  ctx: GraphSchemaContext,
): Promise<GraphSchemaOutcome> {
  const before = new Set(await schemaObjectNames(driver));
  for (const statement of graphSchemaStatements(ctx)) {
    await driver.executeQuery(statement);
  }
  const applied = getMeta(db, SCHEMA_META_KEY) === undefined;
  if (applied) {
    setMeta(db, SCHEMA_META_KEY, new Date().toISOString());
  }
  const created = (await schemaObjectNames(driver)).filter((name) => !before.has(name));
  return { applied, created };
}

/** The schema version recorded as applied, or nothing when none has been. `aion doctor` reads it. */
export function appliedGraphSchemaVersion(db: SqliteHandle): number | undefined {
  return getMeta(db, SCHEMA_META_KEY) === undefined ? undefined : GRAPH_SCHEMA_VERSION;
}
