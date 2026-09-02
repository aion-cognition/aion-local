import type { Driver } from 'neo4j-driver';

import { withoutFingerprints } from './fingerprint.js';
import { redact } from './redact.js';
import { readStoredText } from '../infrastructure/graph/introspection.js';
import { readNodeStringProperties } from '../infrastructure/graph/redaction-residue-writes.js';

/**
 * What an older, leakier ruleset already wrote. Closing a leak path stops the next write; it
 * does nothing about plaintext credentials already written to Neo4j, which remain permanent
 * and recall-eligible since nothing is ever hard-deleted.
 *
 * Removing it is a destructive graph write and belongs to a forget operation that does not
 * exist yet. Counting it does not: an operator with no gauge cannot tell a substrate
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

/** True when at least one of a node's own string properties, scanned on its own, still trips a rule. */
function propertyLeaks(
  properties: Readonly<Record<string, string>>,
  entropyThreshold: number,
  ruleIds: Set<string>,
): boolean {
  let leaks = false;
  for (const value of Object.values(properties)) {
    const { matches } = redact(withoutFingerprints(value), entropyThreshold);
    if (matches.length === 0) {
      continue;
    }
    leaks = true;
    for (const match of matches) {
      ruleIds.add(match.rule);
    }
  }
  return leaks;
}

export async function scanRedactionResidue(
  driver: Driver,
  entropyThreshold: number,
  limit: number = DEFAULT_RESIDUE_SCAN_LIMIT,
): Promise<RedactionResidue> {
  const rows = await readStoredText(driver, limit);

  // The concatenated scan is a cheap first pass, not the verdict: a rule can fire on text
  // that only exists because two clean properties sit next to each other in the join, and
  // the purge (which rewrites one property at a time) can never close a leak counted that
  // way. Candidates from the concatenated pass are re-checked property by property, the same
  // unit of text the purge judges, before either is counted as leaking.
  const candidateIds = rows
    .filter((row) => redact(withoutFingerprints(row.text), entropyThreshold).matches.length > 0)
    .map((row) => row.id);

  const ruleIds = new Set<string>();
  const sampleIds: string[] = [];
  let leaking = 0;

  if (candidateIds.length > 0) {
    const nodes = await readNodeStringProperties(driver, candidateIds);
    for (const node of nodes) {
      if (!propertyLeaks(node.properties, entropyThreshold, ruleIds)) {
        continue;
      }
      leaking += 1;
      if (sampleIds.length < SAMPLE_SIZE && node.id !== '') {
        sampleIds.push(node.id);
      }
    }
  }

  return { scanned: rows.length, leaking, ruleIds: [...ruleIds].sort(), sampleIds };
}
