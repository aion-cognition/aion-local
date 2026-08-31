import type { SqliteHandle } from './database.js';
import { getMeta, setMeta } from './meta.js';

/**
 * How many pack items each recall method has ever produced, since the day this counter
 * shipped. This is the spirit metric's raw material: whether spreading activation and
 * resonance carry their weight against a plain vector or lexical hit, measured from what
 * packs actually served rather than argued from design intent.
 *
 * A subset of `RecallMethodSchema` in `@aion/protocol`, and declared here rather than imported
 * so the infrastructure layer stays free of the protocol layer above it. The protocol also
 * names `graph_traversal`, which is the fusion leg's name rather than any item's: the leg
 * exists, but every item it produces is labelled `activation` by the stage that scored it, so
 * a counter row for it would print zero forever and read as a measurement. Containment is
 * asserted in this module's test.
 */
export const PACK_METHODS = [
  'vector',
  'bm25',
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

/**
 * One method's showing across every pack ever served: admitted items it found with no other
 * method also finding them, admitted items it shared credit for, and the RRF weight it carried
 * into admitted items either way. The counter above only ever credits the method `prefer` in
 * `fusion.ts` picked to explain an item several methods found, so a method that helps rank an
 * item without winning its rationale reads as contributing nothing there. This is the fix.
 */
export type PackMethodLegStat = {
  readonly sole: number;
  readonly shared: number;
  readonly rrfContribution: number;
};

export type PackMethodLegStats = Readonly<Record<PackMethod, PackMethodLegStat>>;

const SOLE_KEY_PREFIX = 'pack_method_sole:';
const SHARED_KEY_PREFIX = 'pack_method_shared:';
const RRF_KEY_PREFIX = 'pack_method_rrf:';

function soleKey(method: string): string {
  return `${SOLE_KEY_PREFIX}${method}`;
}

function sharedKey(method: string): string {
  return `${SHARED_KEY_PREFIX}${method}`;
}

function rrfKey(method: string): string {
  return `${RRF_KEY_PREFIX}${method}`;
}

/** Adds one pack's leg stats to the running total. Call once, at pack persistence. */
export function recordPackMethodLegStats(
  db: SqliteHandle,
  stats: Readonly<Partial<Record<PackMethod, PackMethodLegStat>>>,
): void {
  for (const method of PACK_METHODS) {
    const stat = stats[method];
    if (stat === undefined) {
      continue;
    }
    setMeta(db, soleKey(method), String(Number(getMeta(db, soleKey(method)) ?? '0') + stat.sole));
    setMeta(
      db,
      sharedKey(method),
      String(Number(getMeta(db, sharedKey(method)) ?? '0') + stat.shared),
    );
    setMeta(
      db,
      rrfKey(method),
      String(Number(getMeta(db, rrfKey(method)) ?? '0') + stat.rrfContribution),
    );
  }
}

/** Cumulative sole finds, shared finds, and RRF contribution per method, zero where never recorded. */
export function packMethodLegStats(db: SqliteHandle): PackMethodLegStats {
  return Object.fromEntries(
    PACK_METHODS.map((method) => [
      method,
      {
        sole: Number(getMeta(db, soleKey(method)) ?? '0'),
        shared: Number(getMeta(db, sharedKey(method)) ?? '0'),
        rrfContribution: Number(getMeta(db, rrfKey(method)) ?? '0'),
      },
    ]),
  ) as PackMethodLegStats;
}

/** Both counters for one served pack: the plain per-method share and the leg-share detail. */
export function recordPackMethodMetrics(
  db: SqliteHandle,
  methods: readonly string[],
  legStats: Readonly<Partial<Record<PackMethod, PackMethodLegStat>>>,
): void {
  recordPackMethodCounts(db, methods);
  recordPackMethodLegStats(db, legStats);
}
