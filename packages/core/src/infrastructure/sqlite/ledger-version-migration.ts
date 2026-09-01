import type { SqliteHandle } from './database.js';
import { listLedgerKeys } from './ops-ledger.js';

/**
 * The reflection ledger keys shipped without a version segment. Once the key carries one, every
 * row already in the ledger reads as belonging to no version at all, so the first open after the
 * fork would report the whole substrate as unenriched and re-enqueue every episode in it.
 *
 * This rewrites those keys into the fork the pipeline that wrote them belongs to. It runs on
 * every open and does nothing on a substrate that has already been through it, so it needs no
 * state of its own: a key whose next segment is already a version is left alone.
 */

const ORCHESTRATOR_PREFIX = 'reflection:orchestrator:';
const STAGE_PREFIX = 'reflection:stage:';

/**
 * The version the un-versioned rows belong to. It is a literal rather than the current
 * `PIPELINE_VERSION` because these rows record what the first pipeline version did, and a later
 * bump must not retag them as its own work.
 */
const UNVERSIONED_PIPELINE_VERSION = 'v1';

/** A version segment, which is what tells an already-rewritten key from an original one. */
const VERSION_SEGMENT = /^v\d+$/;

export type LedgerVersionMigrationReport = {
  readonly orchestratorKeys: number;
  readonly stageKeys: number;
};

function needsVersion(key: string, prefix: string): boolean {
  const rest = key.slice(prefix.length);
  const separator = rest.indexOf(':');
  const firstSegment = separator === -1 ? rest : rest.slice(0, separator);
  return !VERSION_SEGMENT.test(firstSegment);
}

/**
 * `UPDATE OR IGNORE` rather than a replace: the versioned key can already exist when an old
 * process wrote the un-versioned one after this ran, and the row that names real work is the one
 * to keep. The stale key is left where it is, since nothing reads it and no ledger row is ever
 * destroyed to tidy up.
 */
function rewriteKeys(db: SqliteHandle, prefix: string, version: string): number {
  const rewrite = db.prepare('UPDATE OR IGNORE ops_ledger SET key = ? WHERE key = ?');
  let rewritten = 0;
  for (const key of listLedgerKeys(db, prefix)) {
    if (!needsVersion(key, prefix)) {
      continue;
    }
    const moved = rewrite.run(`${prefix}${version}:${key.slice(prefix.length)}`, key);
    rewritten += moved.changes;
  }
  return rewritten;
}

/**
 * One transaction for both families, so a crash partway through leaves a substrate that is
 * entirely un-migrated rather than one where the run key moved and its stage keys did not.
 */
export function migrateUnversionedLedgerKeys(db: SqliteHandle): LedgerVersionMigrationReport {
  return db.transaction((): LedgerVersionMigrationReport => ({
    orchestratorKeys: rewriteKeys(db, ORCHESTRATOR_PREFIX, UNVERSIONED_PIPELINE_VERSION),
    stageKeys: rewriteKeys(db, STAGE_PREFIX, UNVERSIONED_PIPELINE_VERSION),
  }))();
}
