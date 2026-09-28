import { readStoredText } from '../../../infrastructure/graph/introspection.js';
import {
  readNodeStringProperties,
  writeRedactedProperties,
  type RedactedPropertyUpdate,
} from '../../../infrastructure/graph/redaction-residue-writes.js';
import { runningBuild } from '../../../infrastructure/running-build.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import { FINGERPRINT_PATTERN, withoutFingerprints } from '../../../redaction/fingerprint.js';
import { redact } from '../../../redaction/redact.js';
import { DEFAULT_RESIDUE_SCAN_LIMIT } from '../../../redaction/residue.js';
import type { HealthSnapshot } from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';

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

/**
 * A node the node-level scan flags and the property-level rewriter cannot fix. Detection reads
 * every string property joined together, so a match that lives only across the join of two
 * properties, or only across a fingerprint boundary, has no single property to rewrite. Without
 * a mark such a node sits at the head of the flagged list forever and takes a slot in every
 * batch, which is a leak nobody is told about starving the ones that can still be fixed.
 *
 * The mark records the build and the entropy threshold it was made under, since those are what
 * decide what the rewriter can do with the node. A later build or a retuned threshold examines
 * the node once more on its own; the same ones never do, so the mark cannot loop either.
 */
export const REDACTION_UNRESOLVED_PREFIX = 'redaction_unresolved:';

export function redactionUnresolvedKey(nodeId: string): string {
  return `${REDACTION_UNRESOLVED_PREFIX}${nodeId}`;
}

/** What a mark was made under. A mark written before it recorded these matches nothing. */
export type RedactionRewriter = {
  readonly build: string;
  readonly entropyThreshold: number;
};

/**
 * Every rewriter a node's mark was made under. A mark from before the history was kept carries at
 * most one, at its top level, so two processes stamped differently (the service and a CLI run)
 * do not re-examine the node each time they take turns.
 */
function examinedUnder(db: SqliteHandle, nodeId: string): readonly RedactionRewriter[] {
  const summary = getLedgerEntry(db, redactionUnresolvedKey(nodeId))?.summary as
    (Partial<RedactionRewriter> & { examined?: unknown }) | undefined;
  const listed = Array.isArray(summary?.examined)
    ? (summary.examined as Partial<RedactionRewriter>[])
    : [summary ?? {}];
  return listed.filter(
    (entry): entry is RedactionRewriter =>
      typeof entry.build === 'string' && typeof entry.entropyThreshold === 'number',
  );
}

function markedUnder(db: SqliteHandle, nodeId: string, rewriter: RedactionRewriter): boolean {
  return examinedUnder(db, nodeId).some(
    (entry) =>
      entry.build === rewriter.build && entry.entropyThreshold === rewriter.entropyThreshold,
  );
}

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
    const at = found.index;
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
      const rewriter: RedactionRewriter = { build: runningBuild(), entropyThreshold: threshold };
      const scanned = await readStoredText(ctx.driver, DEFAULT_RESIDUE_SCAN_LIMIT);

      const leakingIds = scanned
        .filter((row) => stillLeaking(row.text, threshold))
        .map((row) => row.id);
      const fixable = leakingIds.filter((id) => !markedUnder(ctx.db, id, rewriter));
      const batchIds = fixable.slice(0, ctx.config.maintenance.redactionPurgeBatchSize);

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
      let unresolved = 0;
      for (const node of nodes) {
        const properties = redactedProperties(node.properties, threshold);
        if (Object.keys(properties).length > 0) {
          updates.push({ id: node.id, properties });
          continue;
        }
        markLedgerApplied(ctx.db, redactionUnresolvedKey(node.id), {
          reason: 'flagged by the node scan, with no single property this rewriter can redact',
          ...rewriter,
          examined: [...examinedUnder(ctx.db, node.id), rewriter],
        });
        unresolved += 1;
        ctx.logger.warn(
          { nodeId: node.id, build: rewriter.build },
          'redaction residue purge cannot fix a flagged node under this build; ' +
            'it stays flagged and is examined again under a later build or threshold',
        );
      }

      const written = await writeRedactedProperties(ctx.driver, updates, ctx.now);
      return {
        status: written.length === 0 ? 'noop' : 'applied',
        itemsProcessed: batchIds.length,
        itemsAffected: written.length,
        detail:
          `${String(written.length)} of ${String(batchIds.length)} inspected nodes rewritten, ` +
          `${String(leakingIds.length)} flagged this scan, ` +
          `${String(unresolved)} left flagged until a later build or threshold`,
      };
    },
  };
}
