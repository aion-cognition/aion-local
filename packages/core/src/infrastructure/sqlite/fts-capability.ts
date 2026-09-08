import type { SqliteHandle } from './database.js';
import { SOURCE_SEARCH_FTS_STATEMENT, SOURCE_SEARCH_FTS_TABLE } from './source-search-schema.js';

/**
 * Whether this binary can actually hold the search projection, asked of the native connection
 * rather than of a version string or a build flag.
 *
 * The probe runs against `temp`, a per-connection schema that exists only for the life of the
 * handle: creating and dropping a table there proves the module loads and reaches no semantic
 * record on the way. A savepoint would leave the same proof but inside the main schema's
 * transaction, which is a worse place to fail.
 *
 * Absent and broken are different answers and stay different. Absent means the module is not
 * compiled in and search is a capability this deployment does not have; anything else is a
 * failure with its own diagnostic, and reporting it as a missing extension would send an
 * operator to rebuild a binary whose real problem is a damaged file.
 */

/** The temp-schema name the probe creates and drops. Nothing else uses it. */
const PROBE_TABLE = 'aion_fts5_capability_probe';

/** The message SQLite raises when the module is not compiled into the binary. */
const ABSENT_MODULE = /no such module:\s*fts5/i;

export type SearchUnavailableCause = 'fts5_unavailable' | 'search_store_error';

export type FtsCapability =
  | { readonly status: 'available' }
  /** The module is not in this binary. Everything else about the substrate still works. */
  | { readonly status: 'unavailable'; readonly cause: 'fts5_unavailable'; readonly detail: string }
  /** Something else failed, and it keeps its own diagnostic. */
  | { readonly status: 'error'; readonly cause: 'search_store_error'; readonly detail: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classify(err: unknown): FtsCapability {
  const detail = messageOf(err);
  return ABSENT_MODULE.test(detail)
    ? { status: 'unavailable', cause: 'fts5_unavailable', detail }
    : { status: 'error', cause: 'search_store_error', detail };
}

/**
 * The capability itself, proved on a disposable schema. A drop that fails after a successful
 * create still leaves the capability proved: the module loaded, and the leftover table lives
 * only until this connection closes.
 */
export function probeFts5Capability(db: SqliteHandle): FtsCapability {
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.${PROBE_TABLE} USING fts5(body)`);
  } catch (err) {
    return classify(err);
  }
  try {
    db.exec(`DROP TABLE temp.${PROBE_TABLE}`);
  } catch {
    // The create is the proof; a failed drop leaves a temp table this connection will discard.
  }
  return { status: 'available' };
}

/**
 * The capability plus the projection it needs, which is what a search or an indexing run asks
 * for. Creation is guarded by the probe rather than attempted first, so a binary without the
 * module produces a typed cause instead of an exception from the middle of a request.
 */
export function ensureSearchProjection(db: SqliteHandle): FtsCapability {
  const capability = probeFts5Capability(db);
  if (capability.status !== 'available') {
    return capability;
  }
  try {
    db.exec(SOURCE_SEARCH_FTS_STATEMENT);
  } catch (err) {
    return classify(err);
  }
  return { status: 'available' };
}

/** Whether the projection exists on this substrate, for a reader that must not create it. */
export function searchProjectionExists(db: SqliteHandle): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(SOURCE_SEARCH_FTS_TABLE);
  return row !== undefined;
}
