import type { SqliteHandle } from './database.js';
import { SOURCE_SEARCH_FTS_STATEMENT, SOURCE_SEARCH_FTS_TABLE } from './source-search-schema.js';

/**
 * Whether this binary can actually hold the search projection, asked of the native connection
 * rather than of a version string or a build flag.
 *
 * The proof is an executed create inside a savepoint that is then rolled back. The create is
 * what makes it a capability answer rather than a build claim, and the rollback is what makes
 * it reversible: nothing is dropped, nothing is left behind, and a probe that fails halfway
 * unwinds to exactly the state it started in. `temp` keeps it off the main schema as well, so
 * the probe reaches no semantic record even before the rollback.
 *
 * Absent and broken are different answers and stay different. Absent means the module is not
 * compiled in and search is a capability this deployment does not have; anything else is a
 * failure with its own diagnostic, and reporting it as a missing extension would send an
 * operator to rebuild a binary whose real problem is a damaged file.
 */

/** The temp-schema name the probe creates inside its savepoint. Nothing else uses it. */
const PROBE_TABLE = 'aion_fts5_capability_probe';

/** The savepoint the probe unwinds to. Named so a stray one is recognisable in a trace. */
const PROBE_SAVEPOINT = 'aion_fts5_capability_probe';

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
 * The capability itself, proved and then unwound. Every exit path rolls the savepoint back and
 * releases it, so the connection is left exactly as it was found whether the module loaded or
 * not. Nothing is deleted to clean up after it, because nothing survives the rollback.
 */
export function probeFts5Capability(db: SqliteHandle): FtsCapability {
  db.exec(`SAVEPOINT ${PROBE_SAVEPOINT}`);
  let capability: FtsCapability = { status: 'available' };
  try {
    db.exec(`CREATE VIRTUAL TABLE temp.${PROBE_TABLE} USING fts5(body)`);
  } catch (err) {
    capability = classify(err);
  } finally {
    db.exec(`ROLLBACK TO ${PROBE_SAVEPOINT}`);
    db.exec(`RELEASE ${PROBE_SAVEPOINT}`);
  }
  return capability;
}

/**
 * What a reader may ask: the capability, and whether the projection it would query is there.
 *
 * It creates nothing. A read that repaired the substrate would make every refusal path a write
 * path, and the first thing C6 says about these tools is that they are read-only. A missing
 * projection is not reported here at all: to a reader it is a corpus that holds nothing yet,
 * which the completeness disclosure already says better than an availability failure would.
 */
export function readSearchCapability(db: SqliteHandle): FtsCapability {
  return probeFts5Capability(db);
}

/**
 * The capability plus the projection it needs, which is what an indexing run asks for. The
 * writer is the only caller: creation and repair belong to whatever is allowed to change the
 * projection, and a search is not.
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
