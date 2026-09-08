import type { DurableRole, ScopeDirection } from './scopes.js';
import { hashContent } from '../../reflection/domain/content.js';

/**
 * What a stored ownership summary says, and what one asking session may conclude from it.
 *
 * The summary is caller-independent on purpose. A stored "somebody else also has this" boolean
 * answers for the session that computed it and for nobody else, so what is stored is the set of
 * sessions plus the separate fact that some contribution could not be attributed at all. Own and
 * other are derived against the asking session, which is what lets one stored summary answer for
 * every future asker.
 */

/**
 * The roles that make a source an owner of a node: the extraction that minted it and the
 * mentions and participations its writers record about it.
 */
export const OWNERSHIP_SCOPES: readonly {
  readonly role: DurableRole;
  readonly direction: ScopeDirection;
}[] = [
  { role: 'extraction', direction: 'out' },
  { role: 'mention', direction: 'in' },
  { role: 'participation', direction: 'in' },
];

export type OwnershipSummary = {
  /** Every session whose current, disclosable sources carry this node. Sorted, caller-independent. */
  readonly sessions: readonly string[];
  /** A contribution the records cannot attribute to a session. Never rendered as own or as other. */
  readonly unknownAttribution: boolean;
  /** Whether the scopes the attribution was read from have a census behind them. */
  readonly censusEstablished: boolean;
};

export type OwnershipVerdict = 'own_only' | 'shared' | 'unknown';

/**
 * The verdict for one asking session.
 *
 * Everything short of a counted, fully attributed set answers unknown. An unknown verdict is not
 * a claim that somebody else holds the memory: it is the substrate saying it cannot tell, and the
 * serving subtraction treats it as a reason to serve rather than as a reason to withhold.
 */
export function ownershipVerdict(summary: OwnershipSummary, sessionId: string): OwnershipVerdict {
  if (!summary.censusEstablished || summary.unknownAttribution || summary.sessions.length === 0) {
    return 'unknown';
  }
  return summary.sessions.every((session) => session === sessionId) ? 'own_only' : 'shared';
}

/**
 * The stored summary's version. It moves when the derived answer moves and stays put otherwise,
 * so an operation that changes no incidence rewrites nothing and its published sequence keeps
 * pointing at the acknowledgment that established the answer.
 */
export function ownershipEvidenceVersion(summary: OwnershipSummary): string {
  return hashContent({
    sessions: summary.sessions,
    unknownAttribution: summary.unknownAttribution,
    censusEstablished: summary.censusEstablished,
  });
}
