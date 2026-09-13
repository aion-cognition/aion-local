import type { EvidenceScope, PublicationPreconditions } from './preconditions.js';
import type { GraphTransaction } from '../graph/connection.js';
import type { SqliteHandle } from '../sqlite/database.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export const PUBLICATION_PROTOCOL_VERSION = 1;
export const GRAPH_COMPLETION_EFFECT = 'publication:graph_completion';
/**
 * The closed set of operation kinds the coordinator admits, each with its reason stated at the
 * entry where the name does not carry it. A kind outside this list is refused at construction, and
 * a kind here with no installed handler is refused at publish. Count them from this list rather
 * than from any prose about it.
 */
export const PUBLICATION_KINDS = [
  'intake',
  'stated_references',
  'reflection_completion',
  'semantic_write',
  'source_suppression',
  'narrative_publish',
  // A session's narrative family, recorded once and fenced. Its own kind because a revision
  // binds the selection version it published under, and that fence is what a later change to how
  // a session is narrated has to move.
  'narrative_family_selection',
  'coverage_activation',
  'projection_rebuild',
  'episode_eviction',
  'topology_update',
  // A narrative family whose graph currency disagrees with the manifest that owns it: the
  // acknowledged head is right and an earlier revision's node is still standing beside it,
  // which a crash between a publication's graph write and its supersession leaves behind.
  // Its own kind rather than a variant of `narrative_publish`, because it allocates no
  // revision and writes no output: it makes the graph agree with a decision already taken.
  'narrative_family_repair',
  // A calendar overview's own revision: a `scope:window` family with the same revision columns
  // the chunk family has, publishing through the same coordinator. Its own kind because it is
  // its own writer with its own membership fence, not a variant of the chunk publication.
  'overview_publish',
  // Recomputing the served `context_vec` from a node's current neighbourhood. Its own kind
  // rather than a variant of `semantic_write`, because it derives no new meaning: it makes a
  // stored aggregate agree with the neighbourhood it was taken over, and one receipt covers a
  // set of nodes whose membership the intent names exactly. It is a publication at all because
  // three passes had reason to move that property and only a receipt can say which one did.
  'context_vector_sync',
  // The evidence a node derived from a capture is born with: the extraction or mention the stage
  // just wrote, and the censuses a minted id is entitled to. Its own kind rather than a variant of
  // `semantic_write`, because it writes no meaning at all: it records relationships the graph
  // already holds, and the receipt is what says a node's sources were counted from birth rather
  // than by a later walk.
  'derived_node_evidence',
] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];

export type PublicationPlan<D extends JsonValue = JsonValue> = {
  readonly data: D;
  readonly expected: PublicationPreconditions;
  readonly scopes: readonly EvidenceScope[];
  readonly effects: readonly { readonly kind: string; readonly detail: JsonValue }[];
};

/**
 * The verdict a handler returns, with its reason as free text.
 *
 * The reason is deliberately untyped: handlers synthesise it from what they read, and a closed
 * union would push every such refusal through a constant it cannot name in advance. The cost is
 * that nothing stops two handlers naming one condition two ways, and four of them do: a published
 * head moving between prepare and check is reported as `head_moved`, `published_head_moved`,
 * `legacy_head_moved` and `legacy_head_changed`, one per module. Nothing consumes any of them, so
 * grouping refusals by reason under-reports the largest source of contention as four small ones.
 * Consolidating them is a decision about the whole vocabulary and belongs to whoever owns it.
 */
export type PublicationCheck =
  | { readonly status: 'valid' }
  | { readonly status: 'deferred' | 'rejected'; readonly reason: string };

export type PublicationContext = {
  readonly operationId: string;
  readonly sequence: string | null;
  readonly graph: GraphTransaction;
  readonly db: SqliteHandle;
  readonly now: Date;
  /**
   * Which kinds the composition running this operation installed.
   *
   * Almost every handler ignores it. The one that cannot is the arming operation: a process
   * that composed a smaller set cannot recover a pending operation of a kind it does not know,
   * and that is the condition arming a destructive capability has to rule out rather than
   * assume. Read from the coordinator's own map, so a caller cannot state it.
   */
  readonly installedKinds: readonly PublicationKind[];
};

export type PublicationStamp = {
  readonly knownFrom: string;
  readonly observedAckAt: string;
  readonly clockClamped: boolean;
};
export type PublicationSqliteContext = {
  readonly operationId: string;
  readonly sequence: string;
  readonly db: SqliteHandle;
};
/** No sequence: a claim is taken before this request has a record, let alone a place in the order. */
export type PublicationClaimContext = {
  readonly operationId: string;
  readonly db: SqliteHandle;
};
export type PublicationAckContext = PublicationSqliteContext & PublicationStamp;

export type PublicationHandler = {
  readonly kind: PublicationKind;
  readonly effectKinds: readonly string[];
  decodePayload(value: unknown): JsonValue;
  decodeData(value: unknown): JsonValue;
  decodeResult(value: unknown): JsonValue;
  /** Select bounded actions under the guard; durable writes belong in prepareSqlite. */
  prepare(context: PublicationContext, payload: JsonValue): Promise<PublicationPlan>;
  /** Recheck semantic dependencies, source generations and actual published heads. */
  check(context: PublicationContext, plan: PublicationPlan): Promise<PublicationCheck>;
  /**
   * Replay only after the locked receipt proves the preceding attempt uncommitted and check
   * still passes. Mutations must stay within this graph transaction and preserve the prepared
   * identities. Returned observations may differ on replay; a committed receipt's result is final.
   */
  applyGraph(context: PublicationContext, plan: PublicationPlan): Promise<JsonValue>;
  prepareSqlite(context: PublicationSqliteContext, plan: PublicationPlan): unknown;
  acknowledgeSqlite(
    context: PublicationAckContext,
    plan: PublicationPlan,
    result: JsonValue,
  ): unknown;
  /** Preserve accepted input and transfer or retain its outstanding obligations. */
  discardSqlite(context: PublicationSqliteContext, plan: PublicationPlan, reason: string): unknown;
  /**
   * A durable fact this request establishes before the guard settles anything already pending.
   *
   * Almost nothing needs one. A writer's own decision belongs in `prepareSqlite`, which runs once
   * the slot is free and the plan is checked. The exception is a request whose whole purpose is to
   * STOP another kind of operation: the guard finishes what is already there before it takes a new
   * request, so a stop that only becomes durable at its own acknowledgment arrives after the thing
   * it was run to prevent. What is written here is a claim, not an outcome. It is read fail-closed
   * while it stands, and the operation's own outcome is what resolves it.
   */
  claimBeforeRecovery?(context: PublicationClaimContext, payload: JsonValue): unknown;
  /**
   * Releases what `claimBeforeRecovery` claimed, in the step that records this operation ended
   * without acknowledging. A claim its own outcome cannot release is a claim nothing will ever
   * release, and the fence would then be holding a fact no operation stands behind.
   */
  releaseClaim?(context: PublicationClaimContext, payload: JsonValue): unknown;
  /** Optional idempotent materialization; no model work and no receipt replacement. */
  finishGraph?(
    context: PublicationContext,
    plan: PublicationPlan,
    result: JsonValue,
  ): Promise<void>;
};

export type PublicationOutcome =
  | ({
      readonly status: 'acknowledged';
      readonly operationId: string;
      readonly sequence: string;
      readonly result: JsonValue;
    } & PublicationStamp)
  | {
      readonly status: 'deferred' | 'rejected';
      readonly operationId: string;
      readonly sequence: string;
      readonly reason: string;
    };

/** The complete receipt written atomically with a committed graph mutation. */
export type PublicationReceipt = {
  readonly substrateId: string;
  readonly protocolVersion: 1;
  readonly sequence: string;
  readonly operationId: string;
  readonly intentDigest: string;
  readonly resultDigest: string;
};

/**
 * A verified read position also represents the empty, pre-publication guard.
 * Read completion persists SQLite effects only; its graph transaction validates reads and always rolls back.
 */
export type PublicationCheckpoint = Pick<
  PublicationReceipt,
  'substrateId' | 'protocolVersion' | 'sequence'
> & {
  readonly operationId: string | null;
  readonly intentDigest: string | null;
  readonly resultDigest: string | null;
};
export type CheckpointResult =
  | { readonly status: 'ready'; readonly checkpoint: PublicationCheckpoint }
  | { readonly status: 'unavailable'; readonly reason: string };

export type PublicationBoundary =
  'prepared' | 'graph_result_saved' | 'graph_committed' | 'before_ack' | 'acknowledged';
export type PublicationBoundaryEvent = {
  readonly boundary: PublicationBoundary;
  readonly operationId: string;
  readonly sequence: string;
};
export type PublicationMetric = {
  readonly operation: 'publish' | 'recover' | 'complete_read';
  readonly waitMs: number;
  readonly holdMs: number;
  readonly outcome: 'complete' | 'failed';
};
