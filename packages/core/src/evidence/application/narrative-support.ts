import { narrativeRevisionBinding } from '../../infrastructure/sqlite/chunk-manifest.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { countCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';

/**
 * Whether the records still hold up a narrative, asked of the manifest rather than of the graph.
 *
 * The check this replaces was structural: a narrative whose session held no live Episode was an
 * orphan, so a session whose raw containers had been evicted lost the narrative written from them
 * — the one record of what those sources said, deleted for the crime of having been compressed.
 * Eviction is a storage fact and support is an evidence fact, and the two were being read as one.
 *
 * What supports a narrative is a frozen membership or a citation, both of which outlive the raw
 * text. What does NOT support it is a live Episode, and what does not refute it is a missing one.
 *
 * Three answers, and only one of them is a licence. `supported` means the manifest names members
 * or citations behind it. `unknown` means the manifest binds it and can prove neither, which
 * authorizes nothing. `unbound` means these tables were never asked about this id at all, which
 * is where a legacy whole-session narrative sits until its family is cut over; it is silence, not
 * absence, and a caller that reads it as absence has invented a fact.
 */
export type NarrativeSupport = 'supported' | 'unknown' | 'unbound';

export type NarrativeSupportReading = {
  readonly support: NarrativeSupport;
  readonly reason: string;
  readonly members: number;
  readonly citations: number;
};

export function certifyNarrativeSupport(db: SqliteHandle, nodeId: string): NarrativeSupportReading {
  const binding = narrativeRevisionBinding(db, nodeId);
  if (binding === undefined) {
    return {
      support: 'unbound',
      reason: 'the narrative manifest binds no revision to this id',
      members: 0,
      citations: 0,
    };
  }
  const citations = countCitationsFrom(db, nodeId);
  if (binding.members > 0) {
    return {
      support: 'supported',
      reason: `${String(binding.members)} frozen member(s) of ${binding.family} ${binding.familyKey}`,
      members: binding.members,
      citations,
    };
  }
  if (citations > 0) {
    return {
      support: 'supported',
      reason: `${String(citations)} recorded citation(s)`,
      members: 0,
      citations,
    };
  }
  return {
    support: 'unknown',
    reason: `${binding.family} revision ${binding.familyKey}/${String(binding.revisionNo)} carries no recorded member or citation`,
    members: 0,
    citations: 0,
  };
}
