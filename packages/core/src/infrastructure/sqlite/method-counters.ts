import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * How many pack items each recall method has ever produced, since the day this counter
 * shipped. This is the spirit metric's raw material: whether spreading activation and
 * resonance carry their weight against a plain vector or lexical hit, measured from what
 * packs actually served rather than argued from design intent.
 *
 * Mirrors `RecallMethodSchema` in `@aion/protocol`; declared here rather than imported so the
 * infrastructure layer stays free of the protocol layer above it. Parity is asserted in this
 * module's test.
 */
export const PACK_METHODS = [
  'vector',
  'bm25',
  'graph_traversal',
  'activation',
  'resonance',
  'entity_resolution',
  'recency',
] as const;

export type PackMethod = (typeof PACK_METHODS)[number];

export type PackMethodCounters = Readonly<Record<PackMethod, number>>;

const METHOD_COUNT_KEY_PREFIX = 'pack_method_count:';

function methodCountKey(method: string): string {
  return `${METHOD_COUNT_KEY_PREFIX}${method}`;
}

/** One increment per item a pack served, keyed by its own `rationale.method`. Call once, at pack persistence. */
export function recordPackMethodCounts(db: SqliteHandle, methods: readonly string[]): void {
  for (const method of methods) {
    const key = methodCountKey(method);
    const current = Number(getMeta(db, key) ?? '0');
    setMeta(db, key, String(current + 1));
  }
}

/** Cumulative pack items per method, zero for a method that has never produced one. */
export function packMethodCounters(db: SqliteHandle): PackMethodCounters {
  return Object.fromEntries(
    PACK_METHODS.map((method) => [method, Number(getMeta(db, methodCountKey(method)) ?? '0')]),
  ) as PackMethodCounters;
}
