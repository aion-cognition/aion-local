import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readFirstFamilySelection } from '../../infrastructure/sqlite/family-selection.js';
import { readLegacyOriginalClock } from '../../infrastructure/sqlite/legacy-narrative-history.js';
import type { LegacyNarrativeRecord } from '../../infrastructure/sqlite/legacy-narratives.js';
import { readFamilyFence } from '../../reflection/application/family-fence.js';

/** The original publication, not inventory arrival, can place a legacy representation before preference recording began. */
export function legacyBeforeFirstSelection(
  db: SqliteHandle,
  record: LegacyNarrativeRecord | undefined,
  sessionId: string,
  knownAt: Date,
): { dependency: EvidenceDependency; known: boolean | 'unknown' } | undefined {
  if (record?.sessionId !== sessionId) {
    return undefined;
  }
  const first = readFirstFamilySelection(db, sessionId);
  if (first?.family !== 'legacy_session_overview' || first.knownFrom <= knownAt.toISOString()) {
    return undefined;
  }
  const current = readFamilyFence(db, sessionId);
  if (current === undefined) {
    return undefined;
  }
  const original = record.publication?.knownFrom ?? readLegacyOriginalClock(db, record);
  return {
    dependency: current.dependency,
    known: original === undefined ? 'unknown' : original <= knownAt.toISOString(),
  };
}
