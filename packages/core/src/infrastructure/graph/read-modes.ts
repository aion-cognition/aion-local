import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { GraphWriteError } from './errors.js';
import { SUPERSEDES_TYPE } from './relationships.js';
import { toGraphDateTime, type Row } from './values.js';

/**
 * The read side of the bitemporal model. A mode with neither time set is the default:
 * currency-aware, not currency-filtered. Superseded knowledge stays eligible and comes back
 * annotated, and only an explicit forget suppresses a row. Setting a time switches the row
 * set to a temporal slice; both times may be set at once for a full bitemporal point.
 */
export type ReadMode = {
  /** World time: what was true then. */
  readonly validAt?: Date;
  /** System time: what the substrate knew then. */
  readonly knownAt?: Date;
  /**
   * The vantage point a default read judges currency from, for a caller that holds a clock
   * rather than reading one. It moves no predicate and slices no row set, so a read that
   * supplies it is still a default read.
   */
  readonly reference?: Date;
};

export type Currency = 'current' | 'superseded';

export type SupersededBy = {
  readonly id: string;
  readonly at: Date;
};

export type CurrencyAnnotation = {
  readonly currency: Currency;
  readonly supersededBy?: SupersededBy;
};

export type ReadFragment = {
  /** Boolean expression over the node variable; safe to AND into any WHERE. */
  readonly where: string;
  /** Expression yielding `'current' | 'superseded'` relative to this mode's reference time. */
  readonly currency: string;
  /** Expression yielding `{ id, at }` for the node that superseded this one, or null. */
  readonly lineage: string;
  /** `<currency> AS currency, <lineage> AS superseded_by`, ready to splice into a RETURN. */
  readonly projection: string;
  readonly parameters: Record<string, unknown>;
};

/**
 * The default read. `reference` is the caller's clock: a run that reads it once and threads it
 * gets one currency judgment across every read it issues, and a replay judges the episode
 * against its own moment instead of the moment the replay happens.
 */
export function withCurrency(reference?: Date): ReadMode {
  return reference === undefined ? {} : { reference };
}

export function asOf(validAt: Date): ReadMode {
  return { validAt };
}

export function knewAt(knownAt: Date): ReadMode {
  return { knownAt };
}

/** Both timelines pinned at once: what the substrate believed at `knownAt` about `validAt`. */
export function bitemporalAt(validAt: Date, knownAt: Date): ReadMode {
  return { validAt, knownAt };
}

export function isTimeTravel(mode: ReadMode): boolean {
  return mode.validAt !== undefined || mode.knownAt !== undefined;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(name: string, value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new GraphWriteError(`${name} must be a plain Cypher identifier, received ${value}`);
  }
}

/**
 * Composable pieces rather than a finished query: the four seed strategies and the
 * traversal each build their own MATCH and splice the same predicate and annotation in,
 * which is what keeps one definition of currency behind every read path.
 *
 * `prefix` namespaces the parameters and comprehension variables so several fragments
 * (seed node and neighbour, say) can appear in one statement.
 */
export function readModeFragment(mode: ReadMode, nodeVar: string, prefix = 'rm'): ReadFragment {
  assertIdentifier('nodeVar', nodeVar);
  assertIdentifier('prefix', prefix);

  const referenceParam = `${prefix}_reference`;
  const knownAtParam = `${prefix}_known_at`;
  /**
   * Currency is judged from the read's own vantage point: the pinned world time, else the
   * pinned knowledge time, else the caller's own clock, else now. Judging a `knew_at` read
   * against the wall clock marks rows superseded by facts the substrate did not hold yet at
   * that moment.
   */
  const reference = mode.validAt ?? mode.knownAt ?? mode.reference ?? new Date();
  const parameters: Record<string, unknown> = {
    [referenceParam]: toGraphDateTime(reference),
  };

  const predicates: string[] = [];
  if (mode.validAt !== undefined) {
    predicates.push(
      `(${nodeVar}.${BITEMPORAL_PROPERTIES.validFrom} <= $${referenceParam}` +
        ` AND (${nodeVar}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL` +
        ` OR ${nodeVar}.${BITEMPORAL_PROPERTIES.validUntil} > $${referenceParam}))`,
    );
  }
  if (mode.knownAt !== undefined) {
    parameters[knownAtParam] = toGraphDateTime(mode.knownAt);
    predicates.push(
      `(${nodeVar}.${BITEMPORAL_PROPERTIES.txFrom} <= $${knownAtParam}` +
        ` AND (${nodeVar}.${BITEMPORAL_PROPERTIES.txUntil} IS NULL` +
        ` OR ${nodeVar}.${BITEMPORAL_PROPERTIES.txUntil} > $${knownAtParam}))`,
    );
  }
  if (predicates.length === 0) {
    predicates.push(`${nodeVar}.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`);
  }

  const currency =
    `CASE WHEN ${nodeVar}.${BITEMPORAL_PROPERTIES.validUntil} IS NULL` +
    ` OR ${nodeVar}.${BITEMPORAL_PROPERTIES.validUntil} > $${referenceParam}` +
    " THEN 'current' ELSE 'superseded' END";

  const successor = `${prefix}_sup`;
  const successorEdge = `${prefix}_sup_rel`;
  const edgeOpen = `${successorEdge}.${BITEMPORAL_PROPERTIES.txUntil} IS NULL`;
  /**
   * Lineage a reopen closed is lineage the substrate no longer holds, so the default read
   * drops it: `aion unsupersede` restores currency, and a node reported current and superseded
   * at once would be the substrate contradicting itself. A knowledge-time read reports what
   * was recorded by then and still held then, which is what keeps a reopen invisible to a read
   * pinned before it.
   */
  const lineageFilter =
    mode.knownAt === undefined
      ? ` WHERE ${edgeOpen}`
      : ` WHERE ${successorEdge}.created_at <= $${knownAtParam}` +
        ` AND (${edgeOpen} OR ${successorEdge}.${BITEMPORAL_PROPERTIES.txUntil} > $${knownAtParam})`;
  const lineage =
    `head([ (${successor})-[${successorEdge}:${SUPERSEDES_TYPE}]->(${nodeVar})${lineageFilter}` +
    ` | { id: ${successor}.id, at: ${successorEdge}.created_at } ])`;

  return {
    where: predicates.join(' AND '),
    currency,
    lineage,
    projection: `${currency} AS currency, ${lineage} AS superseded_by`,
    parameters,
  };
}

/** Reads back what `ReadFragment.projection` returns; every recall path marks its items through this. */
export function readCurrencyAnnotation(row: Row): CurrencyAnnotation {
  const currency: Currency = row.currency === 'superseded' ? 'superseded' : 'current';
  const lineage = row.superseded_by;
  if (lineage === null || typeof lineage !== 'object') {
    return { currency };
  }
  const { id, at } = lineage as { id?: unknown; at?: unknown };
  if (typeof id !== 'string' || !(at instanceof Date)) {
    return { currency };
  }
  return { currency, supersededBy: { id, at } };
}
