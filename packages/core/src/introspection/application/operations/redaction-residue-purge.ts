import { readStoredText } from '../../../infrastructure/graph/introspection.js';
import {
  readNodeStringProperties,
  writeRedactedProperties,
  type RedactedPropertyUpdate,
} from '../../../infrastructure/graph/redaction-residue-writes.js';
import { redact } from '../../../redaction/redact.js';
import { DEFAULT_RESIDUE_SCAN_LIMIT } from '../../../redaction/residue.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type { IntrospectionOperation, OperationContext, OperationOutcome } from '../../domain/operation.js';

export const REDACTION_RESIDUE_PURGE_OPERATION = 'redaction_residue_purge';

/** What `buildFingerprint` writes: `⟨secret:<rule-id>:<6 hex chars>⟩`. */
const FINGERPRINT_PATTERN = /⟨secret:[a-z0-9-]+:[0-9a-f]{6}⟩/g;

/**
 * `redact()` has no way to know a span is its own earlier output: the fingerprint token
 * embeds the rule id after a colon, which is exactly the `key: value` shape
 * `generic-secret-assignment` matches on. Scanning already-clean text finds that match again
 * and nests a fresh fingerprint inside the last one, forever. Stripping known fingerprint
 * tokens before checking is what tells a genuine new leak apart from the detector echoing
 * its own earlier fix back.
 */
function stillLeaking(text: string, entropyThreshold: number): boolean {
  return redact(text.replace(FINGERPRINT_PATTERN, ''), entropyThreshold).matches.length > 0;
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
export function redactionResiduePurgeRelevance(health: HealthSnapshot): number {
  if (health.redaction.scanned === 0) {
    return 0;
  }
  return Math.min(1, health.redaction.leaking / health.redaction.scanned);
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
    const result = redact(value, entropyThreshold);
    if (result.matches.length > 0) {
      changed[key] = result.text;
    }
  }
  return changed;
}

export function redactionResiduePurgeOperation(): IntrospectionOperation {
  return {
    name: REDACTION_RESIDUE_PURGE_OPERATION,
    tier: 2,
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
