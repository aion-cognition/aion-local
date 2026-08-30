import type { Driver } from 'neo4j-driver';

import { writeStampedNodeInTransaction } from './bitemporal.js';
import { inWriteTransaction, type GraphTransaction } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { lockNodeInTransaction } from './locks.js';

/**
 * A session's node id is the caller-supplied identity itself (the MCP transport's session
 * id in production, an explicit id in tests) rather than a freshly minted UUID. Reusing it
 * verbatim keeps the graph node traceable back to the caller with no side table, and it is
 * what makes MERGE-on-id the whole idempotency story: a second `ensureGraphSession` call
 * for the same identity resolves the same node.
 */
export type EnsureGraphSessionInput = {
  readonly sessionId: string;
  readonly memberId: string;
  readonly workspaceId: string;
  readonly now?: Date;
};

export type EnsureGraphSessionResult = {
  readonly sessionId: string;
  readonly created: boolean;
  /** The prior session's id this one FOLLOWS. Absent for the member's first session. */
  readonly follows?: string;
};

/** INITIATED_BY, WITHIN_WORKSPACE, and FOLLOWS are structural: written once, never reinforced by observation. */
const STRUCTURAL_SIGNALS = ['structural'];
const STRUCTURAL_PROVENANCE = ['session'];

/**
 * The tail of the member's chain in this workspace: the one session nothing else FOLLOWS.
 * Read from the chain's own shape rather than by ordering on `tx_from`, which ties at
 * millisecond resolution: two sessions created in the same millisecond would order by id
 * and the younger could be handed the older's prior, forking the chain. A path has exactly
 * one tail, so this has no tie to break.
 *
 * Only ever called at true node creation (see `ensureGraphSession`), never on a repeat
 * call: re-deriving the tail after later sessions exist would point an older session's
 * FOLLOWS edge at one created after it, cross-linking the chain.
 */
async function findPriorSessionId(
  tx: GraphTransaction,
  input: { sessionId: string; memberId: string; workspaceId: string },
): Promise<string | undefined> {
  const rows = await tx.run(
    [
      'MATCH (s:Session)-[:INITIATED_BY]->(:Member { id: $memberId })',
      'MATCH (s)-[:WITHIN_WORKSPACE]->(:Workspace { id: $workspaceId })',
      'WHERE s.id <> $sessionId AND NOT EXISTS { (:Session)-[:FOLLOWS]->(s) }',
      'RETURN s.id AS id LIMIT 1',
    ].join('\n'),
    { memberId: input.memberId, workspaceId: input.workspaceId, sessionId: input.sessionId },
    (row) => row.id as string,
  );
  return rows[0];
}

/** Reads back an already-linked session's FOLLOWS target; undefined for the member's first session. */
async function readFollowsTarget(
  tx: GraphTransaction,
  sessionId: string,
): Promise<string | undefined> {
  const rows = await tx.run(
    'MATCH (:Session { id: $sessionId })-[:FOLLOWS]->(prior:Session) RETURN prior.id AS id',
    { sessionId },
    (row) => row.id as string,
  );
  return rows[0];
}

/**
 * Lazy Session creation plus the three backbone edges (INITIATED_BY, WITHIN_WORKSPACE,
 * FOLLOWS). The backbone edges and the FOLLOWS chain are established exactly once, on the
 * write that actually creates the node (`node.created`): a repeat call for the same
 * `sessionId` resolves and reports the existing chain instead of re-deriving it, which is
 * both truer to "resolve without writing" and what keeps a repeat call for an older
 * session from ever cross-linking to a session created after it.
 *
 * One transaction, and the Member locked inside it before the chain is derived. The tail
 * of the chain is a read ("the member's most recent other session") that decides a write,
 * which is the shape a concurrent peer breaks: unserialized, two sessions created at once
 * either both point at the same prior session, forking the chain, or point at each other,
 * cycling it. This is the ordinary regime, not an edge case: one service multiplexes many
 * agent sessions, and each new connection creates its session on its first call.
 */
export async function ensureGraphSession(
  driver: Driver,
  input: EnsureGraphSessionInput,
): Promise<EnsureGraphSessionResult> {
  const now = input.now ?? new Date();

  return inWriteTransaction(driver, async (tx) => {
    const node = await writeStampedNodeInTransaction(tx, {
      label: 'Session',
      id: input.sessionId,
      now,
    });

    if (!node.created) {
      const follows = await readFollowsTarget(tx, node.id);
      return { sessionId: node.id, created: false, follows };
    }

    await lockNodeInTransaction(tx, input.memberId, now);

    const priorSessionId = await findPriorSessionId(tx, {
      sessionId: node.id,
      memberId: input.memberId,
      workspaceId: input.workspaceId,
    });

    await upsertEdgeInTransaction(tx, {
      type: 'INITIATED_BY',
      sourceId: node.id,
      targetId: input.memberId,
      strength: 1,
      confidence: 1,
      signals: STRUCTURAL_SIGNALS,
      provenance: STRUCTURAL_PROVENANCE,
      count: 0,
      now,
    });

    await upsertEdgeInTransaction(tx, {
      type: 'WITHIN_WORKSPACE',
      sourceId: node.id,
      targetId: input.workspaceId,
      strength: 1,
      confidence: 1,
      signals: STRUCTURAL_SIGNALS,
      provenance: STRUCTURAL_PROVENANCE,
      count: 0,
      now,
    });

    if (priorSessionId !== undefined) {
      await upsertEdgeInTransaction(tx, {
        type: 'FOLLOWS',
        sourceId: node.id,
        targetId: priorSessionId,
        strength: 1,
        confidence: 1,
        signals: STRUCTURAL_SIGNALS,
        provenance: STRUCTURAL_PROVENANCE,
        count: 0,
        now,
      });
    }

    return { sessionId: node.id, created: true, follows: priorSessionId };
  });
}
