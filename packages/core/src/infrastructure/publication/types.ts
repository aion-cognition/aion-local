import type { EvidenceScope, PublicationPreconditions } from './preconditions.js';
import type { GraphTransaction } from '../graph/connection.js';
import type { SqliteHandle } from '../sqlite/database.js';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export const PUBLICATION_PROTOCOL_VERSION = 1;
export const GRAPH_COMPLETION_EFFECT = 'publication:graph_completion';
export const PUBLICATION_KINDS = [
  'intake',
  'stated_references',
  'reflection_completion',
  'semantic_write',
  'source_suppression',
  'narrative_publish',
  'family_cutover',
  'legacy_materialization',
  'coverage_activation',
  'projection_rebuild',
  'episode_eviction',
  'topology_update',
] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];

export type PublicationPlan<D extends JsonValue = JsonValue> = {
  readonly data: D;
  readonly expected: PublicationPreconditions;
  readonly scopes: readonly EvidenceScope[];
  readonly effects: readonly { readonly kind: string; readonly detail: JsonValue }[];
};

export type PublicationCheck =
  | { readonly status: 'valid' }
  | { readonly status: 'deferred' | 'rejected'; readonly reason: string };

export type PublicationContext = {
  readonly operationId: string;
  readonly sequence: string | null;
  readonly graph: GraphTransaction;
  readonly db: SqliteHandle;
  readonly now: Date;
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

export type PublicationCheckpoint = {
  readonly substrateId: string;
  readonly protocolVersion: 1;
  readonly sequence: string;
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
