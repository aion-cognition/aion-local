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
  /**
   * Whether a reading past its horizon comes back marked `expired`. Absent annotates, so every
   * read path reports an aged-out reading unless the caller holding the kill switch says
   * otherwise. Off restores the two-value answer the substrate gave before a horizon existed,
   * and touches no stored property either way.
   */
  readonly expiryAnnotation?: boolean;
};

/**
 * `superseded` means something corrected the node and the lineage edge names what.
 * `expired` means a reading aged past the horizon it was written with: nothing corrected it,
 * so it has no successor, and the substrate is saying the measurement is old rather than
 * wrong. Both are down-ranked and labeled; neither is dropped.
 */
export type Currency = 'current' | 'superseded' | 'expired';

export type SupersededBy = {
  readonly id: string;
  readonly at: Date;
};

export type CurrencyAnnotation = {
  readonly currency: Currency;
  readonly supersededBy?: SupersededBy;
};

/**
 * When a reading stops answering. Declared here, with the comparator that reads it, rather
 * than with the write that stores it: a horizon is never a close, nothing in the bitemporal
 * predicates may touch it, and its whole meaning is the comparison below.
 */
export const VALID_HORIZON_PROPERTY = 'valid_horizon';

export type ReadFragment = {
  /** Boolean expression over the node variable; safe to AND into any WHERE. */
  readonly where: string;
  /** Expression yielding one `Currency` value relative to this mode's reference time. */
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

/**
 * The three below construct an interval and promise nothing about coverage. Whether the
 * substrate can answer for the moment they name is a separate question, and an application
 * entry point asks it through the coverage checker before it reads. Calling one of these
 * directly in such an entry point would skip that question rather than answer it.
 */
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

/** What a relationship records about its own two clocks: when it was written, and when it left. */
export const EDGE_PROPERTIES = {
  createdAt: 'created_at',
  txUntil: BITEMPORAL_PROPERTIES.txUntil,
  validFrom: BITEMPORAL_PROPERTIES.validFrom,
  validUntil: BITEMPORAL_PROPERTIES.validUntil,
};

export type EdgeFragment = {
  readonly where: string;
  readonly parameters: Record<string, unknown>;
};

/**
 * Whether a traversed relationship was there at the read's own vantage, on both timelines.
 *
 * Node predicates alone do not answer this: three nodes that all existed in January say nothing
 * about an edge written in September, and a join filtered on the nodes returns it anyway. Each
 * axis asks its own question. Knowledge time asks what the substrate had recorded by then and
 * had not retracted by then, and an edge with no recorded creation time cannot prove it was
 * there, so it is not walked rather than assumed. World time asks what held then, and a
 * relationship closed at ten is not part of an eleven o'clock answer whether or not the read
 * pinned a knowledge vantage as well. A relationship carrying no world-time start is open at the
 * start, because its beginning is its capture's and inventing one would drop every ordinary edge.
 *
 * A default read walks everything, as it always has.
 */
export function edgeModeFragment(mode: ReadMode, edgeVar: string, prefix = 'rme'): EdgeFragment {
  assertIdentifier('edgeVar', edgeVar);
  assertIdentifier('prefix', prefix);
  const predicates: string[] = [];
  const parameters: Record<string, unknown> = {};
  if (mode.knownAt !== undefined) {
    const knownAtParam = `${prefix}_edge_known_at`;
    parameters[knownAtParam] = toGraphDateTime(mode.knownAt);
    predicates.push(
      `(${edgeVar}.${EDGE_PROPERTIES.createdAt} IS NOT NULL` +
        ` AND ${edgeVar}.${EDGE_PROPERTIES.createdAt} <= $${knownAtParam}` +
        ` AND (${edgeVar}.${EDGE_PROPERTIES.txUntil} IS NULL` +
        ` OR ${edgeVar}.${EDGE_PROPERTIES.txUntil} > $${knownAtParam}))`,
    );
  }
  if (mode.validAt !== undefined) {
    const validAtParam = `${prefix}_edge_valid_at`;
    parameters[validAtParam] = toGraphDateTime(mode.validAt);
    predicates.push(
      `((${edgeVar}.${EDGE_PROPERTIES.validFrom} IS NULL` +
        ` OR ${edgeVar}.${EDGE_PROPERTIES.validFrom} <= $${validAtParam})` +
        ` AND (${edgeVar}.${EDGE_PROPERTIES.validUntil} IS NULL` +
        ` OR ${edgeVar}.${EDGE_PROPERTIES.validUntil} > $${validAtParam}))`,
    );
  }
  return {
    where: predicates.length === 0 ? 'true' : predicates.join(' AND '),
    parameters,
  };
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

  /**
   * The close is asked first: a reading that was corrected before it aged out is superseded,
   * and that is the arm with a successor to name. A horizon suppresses nothing here, it only
   * decides which word the row comes back with, so an aged-out reading still surfaces and
   * still says what it measured.
   */
  const arms = [
    `WHEN ${nodeVar}.${BITEMPORAL_PROPERTIES.validUntil} IS NOT NULL` +
      ` AND ${nodeVar}.${BITEMPORAL_PROPERTIES.validUntil} <= $${referenceParam}` +
      " THEN 'superseded'",
  ];
  if (mode.expiryAnnotation !== false) {
    arms.push(
      `WHEN ${nodeVar}.${VALID_HORIZON_PROPERTY} IS NOT NULL` +
        ` AND ${nodeVar}.${VALID_HORIZON_PROPERTY} <= $${referenceParam}` +
        " THEN 'expired'",
    );
  }
  const currency = `CASE ${arms.join(' ')} ELSE 'current' END`;

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

/**
 * The word the projection returned, narrowed. Anything else reads as `current`, including an
 * absent projection: a row nothing annotated must not be reported as one the reader has to
 * discount.
 */
function readCurrency(value: unknown): Currency {
  if (value === 'superseded' || value === 'expired') {
    return value;
  }
  return 'current';
}

/** Reads back what `ReadFragment.projection` returns; every recall path marks its items through this. */
export function readCurrencyAnnotation(row: Row): CurrencyAnnotation {
  const currency = readCurrency(row.currency);
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
