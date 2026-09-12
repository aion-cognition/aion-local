import {
  sourceSuppressionOperationId,
  sourceSuppressionPublication,
  type GraphConnection,
  type Logger,
  type PublicationOutcome,
  type SqliteHandle,
} from '@aion/core';

import { lifecyclePublications } from './lifecycle.js';
import { stderrWriter, type Writer } from './output.js';

/**
 * The one path `aion forget` and `aion unforget` both write through.
 *
 * Two commands, one act each, one writer. The coordinator decides whether the act lands: the
 * command supplies the node and the moment it was asked, and everything about whether the node
 * is there and what state it is in is re-derived under the guard, because a preview taken before
 * the guard is a reading of a node that may have moved since.
 */

export type SuppressionTarget = {
  readonly connection: GraphConnection;
  readonly db: SqliteHandle;
  readonly logger: Logger;
};

export type SuppressionAct = 'forget' | 'unforget';

/** What each refusal means to whoever typed the command, and whether it is a failure. */
const REFUSALS: Readonly<Record<string, { readonly ok: boolean; readonly say: string }>> = {
  node_absent: { ok: false, say: 'no node found for' },
  already_forgotten: { ok: true, say: 'already forgotten:' },
  not_forgotten: { ok: true, say: 'not forgotten, so there is nothing to undo:' },
};

function reportRefusal(nodeId: string, reason: string, write: Writer): number {
  const known = REFUSALS[reason];
  if (known === undefined) {
    stderrWriter(`the substrate refused the act on ${nodeId}: ${reason}`);
    return 1;
  }
  const line = `${known.say} ${nodeId}`;
  if (known.ok) {
    write(line);
    return 0;
  }
  stderrWriter(line);
  return 1;
}

export type SuppressionReport = {
  readonly code: number;
  readonly outcome: PublicationOutcome;
};

/**
 * Publishes one act and answers with the exit code and the receipt.
 *
 * The operation identity carries the act, the node and the instant, so a second invocation is a
 * second operation with its own receipt rather than a replay of the first. A reader asking what
 * happened to this node reads the chain of them.
 */
export async function publishSuppression(
  target: SuppressionTarget,
  act: SuppressionAct,
  nodeId: string,
  now: Date,
): Promise<SuppressionReport> {
  const publications = await lifecyclePublications(target);
  const outcome = await publications.publish({
    kind: sourceSuppressionPublication.kind,
    operationId: sourceSuppressionOperationId(act, nodeId, now),
    payload: { act, nodeId, observedAt: now.toISOString() },
  });
  return { code: outcome.status === 'acknowledged' ? 0 : 1, outcome };
}

/** The acknowledged line, or the refusal rendered as the operator's own answer. */
export function reportSuppression(
  act: SuppressionAct,
  nodeId: string,
  report: SuppressionReport,
  logger: Logger,
  write: Writer,
): number {
  const { outcome } = report;
  if (outcome.status !== 'acknowledged') {
    logger.info({ nodeId, act, status: outcome.status, reason: outcome.reason }, 'act refused');
    return reportRefusal(nodeId, outcome.reason, write);
  }
  logger.warn({ nodeId, act, knownFrom: outcome.knownFrom }, `node ${act}`);
  write(
    act === 'forget'
      ? `forgot ${nodeId} at ${outcome.knownFrom}`
      : `unforgot ${nodeId} at ${outcome.knownFrom}`,
  );
  write(
    act === 'forget'
      ? 'nothing was deleted; --as-of/--knew-at reads on `aion search` still find it, and ' +
          '`aion unforget <id>` takes it back'
      : 'the forget stays on the record; the statement chain says it was taken back',
  );
  return 0;
}
