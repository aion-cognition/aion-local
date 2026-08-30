import type { Driver } from 'neo4j-driver';

import { withoutFingerprints } from './fingerprint.js';
import { redact } from './redact.js';
import { readStoredText } from '../infrastructure/graph/introspection.js';

/**
 * What an older, leakier ruleset already wrote. Closing a leak path stops the next write; it
 * does nothing about plaintext credentials already written to Neo4j, which remain permanent
 * and recall-eligible since nothing is ever hard-deleted.
 *
 * Removing it is a destructive graph write and belongs to the forget operation, which this
 * phase does not ship. Counting it does not: an operator with no gauge cannot tell a substrate
 * that was never leaked into from one that was, and the whole point of the closures is that
 * the difference is now knowable. Redaction is deterministic by design, which is what makes
 * re-running the current rules over stored text a measurement rather than a guess.
 */

/** Nodes scanned per check. The substrate is local and single-user; this is a ceiling, not a page. */
export const DEFAULT_RESIDUE_SCAN_LIMIT = 5000;

export type RedactionResidue = {
  readonly scanned: number;
  /** Nodes whose stored text still matches a current rule. */
  readonly leaking: number;
  /** Which rules fired, so the report names a shape rather than a count. */
  readonly ruleIds: readonly string[];
  /** Node ids, capped, so an operator has somewhere to start rather than a number. */
  readonly sampleIds: readonly string[];
};

const SAMPLE_SIZE = 5;

export async function scanRedactionResidue(
  driver: Driver,
  entropyThreshold: number,
  limit: number = DEFAULT_RESIDUE_SCAN_LIMIT,
): Promise<RedactionResidue> {
  const rows = await readStoredText(driver, limit);
  const ruleIds = new Set<string>();
  const sampleIds: string[] = [];
  let leaking = 0;

  for (const row of rows) {
    // Fingerprints out first: a node this check already had rewritten still carries a
    // `key: value`-shaped token, and counting that as a leak makes the count unclosable.
    const { matches } = redact(withoutFingerprints(row.text), entropyThreshold);
    if (matches.length === 0) {
      continue;
    }
    leaking += 1;
    for (const match of matches) {
      ruleIds.add(match.rule);
    }
    if (sampleIds.length < SAMPLE_SIZE) {
      sampleIds.push(row.id);
    }
  }

  return { scanned: rows.length, leaking, ruleIds: [...ruleIds].sort(), sampleIds };
}
