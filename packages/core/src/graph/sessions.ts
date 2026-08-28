import type { Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES, writeStampedNode } from './bitemporal.js';
import { runRead } from './connection.js';
import { upsertEdge } from './edges.js';

/**
 * Whitepaper §4.2 / PRD §3.3, §5.3: a session's node id is the caller-supplied identity
 * itself (the MCP transport's session id in production, an explicit id in tests) rather
 * than a freshly minted UUID. Reusing it verbatim keeps the graph node traceable back to
 * the caller with no side table, and it is what makes MERGE-on-id the whole idempotency
 * story: a second `ensureGraphSession` call for the same identity resolves the same node.
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
 * The member's most recent other session in this workspace, by write order (`tx_from`).
 * Only ever called at true node creation (see `ensureGraphSession`), never on a repeat
 * call: re-deriving "most recent other session" after later sessions exist would point an
 * older session's FOLLOWS edge at one created after it, cross-linking the chain.
 */
async function findPriorSessionId(
  driver: Driver,
  input: { sessionId: string; memberId: string; workspaceId: string },
): Promise<string | undefined> {
  const rows = await runRead(
    driver,
    [
      'MATCH (s:Session)-[:INITIATED_BY]->(:Member { id: $memberId })',
      'MATCH (s)-[:WITHIN_WORKSPACE]->(:Workspace { id: $workspaceId })',
      'WHERE s.id <> $sessionId',
      `RETURN s.id AS id ORDER BY s.${BITEMPORAL_PROPERTIES.txFrom} DESC, s.id DESC LIMIT 1`,
    ].join('\n'),
    { memberId: input.memberId, workspaceId: input.workspaceId, sessionId: input.sessionId },
    (row) => row.id as string,
  );
  return rows[0];
}

/** Reads back an already-linked session's FOLLOWS target; undefined for the member's first session. */
async function readFollowsTarget(driver: Driver, sessionId: string): Promise<string | undefined> {
  const rows = await runRead(
    driver,
    'MATCH (:Session { id: $sessionId })-[:FOLLOWS]->(prior:Session) RETURN prior.id AS id',
    { sessionId },
    (row) => row.id as string,
  );
  return rows[0];
}

/**
 * Whitepaper §4.2: lazy Session creation plus the three backbone edges (INITIATED_BY,
 * WITHIN_WORKSPACE, FOLLOWS). The backbone edges and the FOLLOWS chain are established
 * exactly once, on the write that actually creates the node (`node.created`) — a repeat
 * call for the same `sessionId` resolves and reports the existing chain instead of
 * re-deriving it, which is both truer to "resolve without writing" and what keeps a
 * repeat call for an older session from ever cross-linking to a session created after it.
 * The manager in `core/session/` adds an in-memory shortcut on top of this for the common
 * case, but this function is safe to call directly and repeatedly.
 */
export async function ensureGraphSession(
  driver: Driver,
  input: EnsureGraphSessionInput,
): Promise<EnsureGraphSessionResult> {
  const now = input.now ?? new Date();

  const node = await writeStampedNode(driver, {
    label: 'Session',
    id: input.sessionId,
    now,
  });

  if (!node.created) {
    const follows = await readFollowsTarget(driver, node.id);
    return { sessionId: node.id, created: false, follows };
  }

  await upsertEdge(driver, {
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

  await upsertEdge(driver, {
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

  const priorSessionId = await findPriorSessionId(driver, {
    sessionId: node.id,
    memberId: input.memberId,
    workspaceId: input.workspaceId,
  });

  if (priorSessionId !== undefined) {
    await upsertEdge(driver, {
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
}
