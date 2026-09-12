import { z } from 'zod';

import { GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import {
  forgetNodeInTransaction,
  suppressionStateInTransaction,
  unforgetNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { readScopeMirror, recordScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';
import { readSourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import {
  acknowledgeSourceStateVersions,
  releasePreparedSourceStateVersions,
  recordSourceStateVersion,
} from '../../infrastructure/sqlite/source-lifecycle.js';

/**
 * Forgetting a node, and taking that back, under the guard.
 *
 * `aion forget` was the last writer in the tree that closed a node from a command with no
 * receipt behind it: a `SET forgotten_at` through the driver, with nothing durable recording
 * that somebody said it. The graph stamp and the statement have to land together or the two
 * disagree — a substrate whose node is suppressed and whose records never heard about it
 * cannot answer why, and the answer outlives the content it was about.
 *
 * The unforget is the same kind because it is the same statement chain. `source_state_versions`
 * has admitted an `unforgotten` kind since the chain was written and had no writer anywhere, so
 * a forget was durable and permanent at once. It is the chain's own reversal, read off the
 * newest statement rather than by erasing the one before it (`committedForget`), which is why it
 * belongs in the family that wrote the forget and not beside `unsupersede`. Reopening a
 * supersession still does not undo a forget and this does not undo a supersession: two
 * suppressions, one act each.
 *
 * A node that is not a source gets the stamp and the receipt and no state version. The statement
 * table is keyed by source and there is no second table for the rest of the graph; the intent row
 * is the durable record in that case, and the difference is visible rather than papered over.
 */

export const SOURCE_SUPPRESSION_EFFECT = 'source_suppression_statement';

const Payload = z.strictObject({
  act: z.enum(['forget', 'unforget']),
  nodeId: z.string().min(1),
  /** When the operator asked, which is the statement's own clock; `known_from` is the ack's. */
  observedAt: z.string().min(1),
});
const Result = z.strictObject({ changed: z.boolean() });

type SuppressionData = z.infer<typeof Payload>;

/** The identity one act takes, so a replay lands on its own receipt rather than a second one. */
export function sourceSuppressionOperationId(
  act: 'forget' | 'unforget',
  nodeId: string,
  at: Date,
): string {
  return `source-suppression:${act}:${nodeId}:${at.toISOString()}`;
}

export const sourceSuppressionPublication = new PublicationOperation({
  kind: 'source_suppression',
  effectKinds: [SOURCE_SUPPRESSION_EFFECT],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('a suppression cannot publish before the coverage registry exists');
    }
    return Promise.resolve({
      data: payload,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      // Declared empty on `narrative-repair`'s pattern: the scope this act moves is the node's
      // own state mirror, and that is advanced in the acknowledgment where the change is made.
      scopes: [],
      effects: [
        { kind: SOURCE_SUPPRESSION_EFFECT, detail: { nodeId: payload.nodeId, act: payload.act } },
      ],
    });
  },
  async check(context, data) {
    // Read inside the operation's transaction, never carried from the command: a node forgotten
    // between the preview and the guard is a different node to decide about, and a forget has no
    // reopen path that does not itself have to be published.
    const state = await suppressionStateInTransaction(context.graph, data.nodeId);
    if (!state.present) {
      return { status: 'deferred', reason: 'node_absent' } as const;
    }
    if (data.act === 'forget' && state.forgotten) {
      return { status: 'deferred', reason: 'already_forgotten' } as const;
    }
    if (data.act === 'unforget' && !state.forgotten) {
      return { status: 'deferred', reason: 'not_forgotten' } as const;
    }
    return { status: 'valid' } as const;
  },
  async applyGraph(context, data) {
    if (data.act === 'unforget') {
      const reopened = await unforgetNodeInTransaction(context.graph, { id: data.nodeId });
      return { changed: reopened?.justUnforgotten === true };
    }
    const forgotten = await forgetNodeInTransaction(context.graph, {
      id: data.nodeId,
      now: context.now,
    });
    return { changed: forgotten?.justForgotten === true };
  },
  prepareSqlite(context, data) {
    if (readSourceRecord(context.db, data.nodeId) === undefined) {
      return undefined;
    }
    // Written with no `known_from`: durable, invisible, and promoted only by the acknowledgment.
    recordSourceStateVersion(context.db, {
      sourceId: data.nodeId,
      stateKind: data.act === 'forget' ? 'forgotten' : 'unforgotten',
      operationId: context.operationId,
      observedAt: new Date(data.observedAt),
      detail: { basis: 'operator_statement' },
    });
    return undefined;
  },
  acknowledgeSqlite(context, data, result) {
    if (!result.changed) {
      // The graph found nothing to move, so there is no act for a statement to be about. The
      // prepared row is keyed on this operation and no retry could ever adopt it.
      releasePreparedSourceStateVersions(context.db, context.operationId);
      return undefined;
    }
    acknowledgeSourceStateVersions(context.db, context.operationId, context.knownFrom);
    // The node's own semantic state moved, so evidence somebody is holding about that state
    // stops being current here, in the operation that moved it. Left alone, a judgment fenced on
    // the reading this act invalidated would still verify as current.
    const held = readScopeMirror(context.db, {
      endpointId: data.nodeId,
      relationClass: GRAPH_NODE_SCOPE,
    });
    recordScopeMirror(context.db, {
      endpointId: data.nodeId,
      relationClass: GRAPH_NODE_SCOPE,
      mirroredRevision: (held?.mirroredRevision ?? 0) + 1,
      operationId: context.operationId,
      mirroredAt: new Date(context.knownFrom),
    });
    return undefined;
  },
  discardSqlite(context) {
    // Terminal for this operation: the statement it prepared is keyed on an identity that will
    // never acknowledge, and an unacknowledged row reads as a decision about to move forever.
    releasePreparedSourceStateVersions(context.db, context.operationId);
    return undefined;
  },
});

export type { SuppressionData };
