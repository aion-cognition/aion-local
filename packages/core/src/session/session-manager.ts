import type { Driver } from 'neo4j-driver';

import { ensureGraphSession } from '../infrastructure/graph/sessions.js';

/** The backbone ids every session links to. Resolve once via `bootstrapBackbone` at startup. */
export type SessionManagerBackbone = {
  readonly memberId: string;
  readonly workspaceId: string;
};

export type EnsureSessionInput = {
  /** Caller-supplied identity: the MCP transport's session id in production, an explicit id in tests. */
  readonly identity: string;
  readonly now?: Date;
};

export type EnsureSessionResult = {
  readonly sessionId: string;
  readonly created: boolean;
};

/**
 * One instance per long-lived service process, holding the identity→session-id resolutions
 * it has already made. A repeated `ensureSession` call for a known identity returns from
 * that cache without a graph round trip at all, which is distinct from (and cheaper than)
 * `ensureGraphSession`'s own MERGE-level idempotency. The in-flight map collapses concurrent
 * first calls for the same brand-new identity into one write instead of a race between
 * duplicate creates.
 */
export class SessionManager {
  readonly #driver: Driver;
  readonly #backbone: SessionManagerBackbone;
  readonly #resolved = new Map<string, string>();
  readonly #inFlight = new Map<string, Promise<EnsureSessionResult>>();

  constructor(driver: Driver, backbone: SessionManagerBackbone) {
    this.#driver = driver;
    this.#backbone = backbone;
  }

  /**
   * The session id for an identity, with no graph write. A Session node is minted by the
   * first call that produces content, never by connecting or by reading. Empty sessions still
   * add edges to both structural hubs and a link to the FOLLOWS chain. `ensureGraphSession`
   * keys the node on the identity verbatim, so the id is known before the node exists.
   */
  sessionIdFor(identity: string): string {
    if (identity.length === 0) {
      throw new Error('session identity must be a non-empty string');
    }
    return this.#resolved.get(identity) ?? identity;
  }

  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    const { identity } = input;
    if (identity.length === 0) {
      throw new Error('session identity must be a non-empty string');
    }

    const resolved = this.#resolved.get(identity);
    if (resolved !== undefined) {
      return { sessionId: resolved, created: false };
    }

    const inFlight = this.#inFlight.get(identity);
    if (inFlight !== undefined) {
      return inFlight;
    }

    const promise = this.#create(identity, input.now);
    this.#inFlight.set(identity, promise);
    try {
      return await promise;
    } finally {
      this.#inFlight.delete(identity);
    }
  }

  async #create(identity: string, now: Date | undefined): Promise<EnsureSessionResult> {
    const result = await ensureGraphSession(this.#driver, {
      sessionId: identity,
      memberId: this.#backbone.memberId,
      workspaceId: this.#backbone.workspaceId,
      now,
    });
    this.#resolved.set(identity, result.sessionId);
    return { sessionId: result.sessionId, created: result.created };
  }
}
