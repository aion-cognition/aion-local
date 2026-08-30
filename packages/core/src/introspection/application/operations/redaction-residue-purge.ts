import { readStoredText } from '../../../infrastructure/graph/introspection.js';
import {
  readNodeStringProperties,
  writeRedactedProperties,
  type RedactedPropertyUpdate,
} from '../../../infrastructure/graph/redaction-residue-writes.js';
import {
  FINGERPRINT_PATTERN,
  withoutFingerprints,
} from '../../../redaction/fingerprint.js';
import { redact } from '../../../redaction/redact.js';
import { DEFAULT_RESIDUE_SCAN_LIMIT } from '../../../redaction/residue.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationContext, OperationOutcome } from '../../domain/operation.js';

export const REDACTION_RESIDUE_PURGE_OPERATION = 'redaction_residue_purge';

/**
 * The same test `scanRedactionResidue` runs, so the count that selects this operation and the
 * check that decides which nodes it rewrites cannot drift apart.
 */
function stillLeaking(text: string, entropyThreshold: number): boolean {
  return redact(withoutFingerprints(text), entropyThreshold).matches.length > 0;
}

/**
 * `aion doctor`'s `redaction-residue` check finds what an older, leakier ruleset already
 * wrote: nothing is ever hard-deleted, so a closed leak path stops the next write and does
 * nothing about the plaintext already stored. This operation is the fix the check has no
 * way to apply itself.
 *
 * The check scans concatenated text (`readStoredText`), which is enough to know a node
 * leaks but not which of its own properties does. This runs the same detector, then goes
 * back for the leaking nodes' individual properties, redacts each one on its own, and
 * writes back only the ones that changed: a property update, never a delete, `redacted_at`
 * stamped so the rewrite itself is bitemporally honest about when it happened.
 */
/**
 * A floor, not a share. Every other operation's subject is proportional hygiene, where a small
 * number out of a large scan genuinely is a small problem. This one's subject is a plaintext
 * secret sitting in the graph, and thirteen of them out of two thousand nodes is not thirteen
 * two-thousandths of a problem. The share still orders a large residue above a small one; the
 * floor is what stops a small one from waiting days on starvation protection to be noticed.
 */
export const REDACTION_RESIDUE_MIN_RELEVANCE = 0.5;

export function redactionResiduePurgeRelevance(health: HealthSnapshot): number {
  if (health.redaction.scanned === 0 || health.redaction.leaking === 0) {
    return 0;
  }
  return Math.max(
    REDACTION_RESIDUE_MIN_RELEVANCE,
    Math.min(1, health.redaction.leaking / health.redaction.scanned),
  );
}

/**
 * Redacts around the fingerprints already in the text rather than through them.
 *
 * A fingerprint is `key: value` shaped, so redacting text that contains one makes
 * `generic-secret-assignment` match the fingerprint itself and nest a fresh one inside it,
 * which buries the rule id that says what the original leak was. Splitting on the fingerprints
 * and redacting only the spans between them leaves each earlier fix intact and still catches
 * every new leak, since a span that was already replaced holds no secret to find.
 */
function redactAroundFingerprints(
  text: string,
  entropyThreshold: number,
): { readonly text: string; readonly matches: number } {
  const parts: string[] = [];
  let matches = 0;
  let cursor = 0;
  for (const found of text.matchAll(FINGERPRINT_PATTERN)) {
    const at = found.index ?? 0;
    const segment = redact(text.slice(cursor, at), entropyThreshold);
    matches += segment.matches.length;
    parts.push(segment.text, found[0]);
    cursor = at + found[0].length;
  }
  const tail = redact(text.slice(cursor), entropyThreshold);
  matches += tail.matches.length;
  parts.push(tail.text);
  return { text: parts.join(''), matches };
}

/** Every string property whose own text still trips a rule, keyed by name; `id` never enters this map. */
function redactedProperties(
  properties: Readonly<Record<string, string>>,
  entropyThreshold: number,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!stillLeaking(value, entropyThreshold)) {
      continue;
    }
    const result = redactAroundFingerprints(value, entropyThreshold);
    if (result.matches > 0) {
      changed[key] = result.text;
    }
  }
  return changed;
}

export function redactionResiduePurgeOperation(): IntrospectionOperation {
  return {
    name: REDACTION_RESIDUE_PURGE_OPERATION,
    bucket: 'hour',
    relevance: redactionResiduePurgeRelevance,
    measure: (health) => health.redaction.leaking,
    improves: 'lower',
    run: async (ctx: OperationContext): Promise<OperationOutcome> => {
      const threshold = ctx.config.redaction.entropyThreshold;
      const scanned = await readStoredText(ctx.driver, DEFAULT_RESIDUE_SCAN_LIMIT);

      const leakingIds = scanned.filter((row) => stillLeaking(row.text, threshold)).map((row) => row.id);
      const batchIds = leakingIds.slice(0, ctx.config.maintenance.redactionPurgeBatchSize);

      if (batchIds.length === 0 || ctx.signal.aborted) {
        return {
          status: 'noop',
          itemsProcessed: scanned.length,
          itemsAffected: 0,
          detail: `0 of ${String(scanned.length)} scanned nodes rewritten, ${String(leakingIds.length)} flagged`,
        };
      }

      const nodes = await readNodeStringProperties(ctx.driver, batchIds);
      const updates: RedactedPropertyUpdate[] = [];
      for (const node of nodes) {
        const properties = redactedProperties(node.properties, threshold);
        if (Object.keys(properties).length > 0) {
          updates.push({ id: node.id, properties });
        }
      }

      const written = await writeRedactedProperties(ctx.driver, updates, ctx.now);
      return {
        status: written.length === 0 ? 'noop' : 'applied',
        itemsProcessed: batchIds.length,
        itemsAffected: written.length,
        detail: `${String(written.length)} of ${String(batchIds.length)} inspected nodes rewritten, ${String(leakingIds.length)} flagged this scan`,
      };
    },
  };
}
