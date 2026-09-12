import { PublicationUnavailable } from './errors.js';
import type { PublicationPreconditions } from './preconditions.js';
import { GRAPH_COMPLETION_EFFECT } from './types.js';
import type {
  JsonValue,
  PublicationAckContext,
  PublicationClaimContext,
  PublicationCheck,
  PublicationContext,
  PublicationHandler,
  PublicationKind,
  PublicationPlan,
  PublicationSqliteContext,
} from './types.js';

type Decoder<T> = { parse(value: unknown): T };
export type PublicationDefinition<P extends JsonValue, D extends JsonValue, R extends JsonValue> = {
  readonly kind: PublicationKind;
  readonly effectKinds: readonly string[];
  readonly payload: Decoder<P>;
  readonly data: Decoder<D>;
  readonly result: Decoder<R>;
  /** Preserve the caller's observed dependencies; do not replace them with a fresh read to bless stale output. */
  prepare(context: PublicationContext, payload: P): Promise<PublicationPlan<D>>;
  check(
    context: PublicationContext,
    data: D,
    expected: PublicationPreconditions,
  ): Promise<PublicationCheck>;
  applyGraph(context: PublicationContext, data: D): Promise<R>;
  prepareSqlite(context: PublicationSqliteContext, data: D): undefined;
  acknowledgeSqlite(context: PublicationAckContext, data: D, result: R): undefined;
  discardSqlite(context: PublicationSqliteContext, data: D, reason: string): undefined;
  claimBeforeRecovery?(context: PublicationClaimContext, payload: P): undefined;
  releaseClaim?(context: PublicationClaimContext, payload: P): undefined;
  finishGraph?(context: PublicationContext, data: D, result: R): Promise<void>;
};

/** Code owns handlers; only validated data is written into an intent. */
export class PublicationOperation<
  P extends JsonValue,
  D extends JsonValue,
  R extends JsonValue,
> implements PublicationHandler {
  readonly kind: PublicationKind;
  readonly effectKinds: readonly string[];
  readonly #definition: PublicationDefinition<P, D, R>;
  readonly finishGraph?: PublicationHandler['finishGraph'];
  readonly claimBeforeRecovery?: PublicationHandler['claimBeforeRecovery'];
  readonly releaseClaim?: PublicationHandler['releaseClaim'];

  constructor(definition: PublicationDefinition<P, D, R>) {
    this.kind = definition.kind;
    this.effectKinds = Object.freeze([...definition.effectKinds]);
    this.#definition = definition;
    if (definition.claimBeforeRecovery !== undefined) {
      const claim = definition.claimBeforeRecovery.bind(definition);
      this.claimBeforeRecovery = (context, payload) => {
        claim(context, this.decodePayload(payload));
      };
    }
    if (definition.releaseClaim !== undefined) {
      const release = definition.releaseClaim.bind(definition);
      this.releaseClaim = (context, payload) => {
        release(context, this.decodePayload(payload));
      };
    }
    if (definition.finishGraph !== undefined) {
      const finish = definition.finishGraph.bind(definition);
      this.finishGraph = async (context, plan, result) => {
        await finish(context, definition.data.parse(plan.data), definition.result.parse(result));
      };
    }
  }

  decodePayload(value: unknown): P {
    return this.#definition.payload.parse(value);
  }
  decodeData(value: unknown): D {
    return this.#definition.data.parse(value);
  }
  decodeResult(value: unknown): R {
    return this.#definition.result.parse(value);
  }
  async prepare(context: PublicationContext, payload: JsonValue): Promise<PublicationPlan> {
    return this.#definition.prepare(context, this.decodePayload(payload));
  }
  async check(context: PublicationContext, plan: PublicationPlan): Promise<PublicationCheck> {
    return this.#definition.check(context, this.decodeData(plan.data), plan.expected);
  }
  async applyGraph(context: PublicationContext, plan: PublicationPlan): Promise<JsonValue> {
    return this.decodeResult(
      await this.#definition.applyGraph(context, this.decodeData(plan.data)),
    );
  }
  prepareSqlite(context: PublicationSqliteContext, plan: PublicationPlan): unknown {
    const invoke: (context: PublicationSqliteContext, data: D) => unknown =
      this.#definition.prepareSqlite.bind(this.#definition);
    return invoke(context, this.decodeData(plan.data));
  }
  acknowledgeSqlite(
    context: PublicationAckContext,
    plan: PublicationPlan,
    result: JsonValue,
  ): unknown {
    const invoke: (context: PublicationAckContext, data: D, result: R) => unknown =
      this.#definition.acknowledgeSqlite.bind(this.#definition);
    return invoke(context, this.decodeData(plan.data), this.decodeResult(result));
  }
  discardSqlite(context: PublicationSqliteContext, plan: PublicationPlan, reason: string): unknown {
    const invoke: (context: PublicationSqliteContext, data: D, reason: string) => unknown =
      this.#definition.discardSqlite.bind(this.#definition);
    return invoke(context, this.decodeData(plan.data), reason);
  }
}

/** A saved requirement is not silently completed by a binary lacking its handler. */
export function validatePublicationEffects(
  handler: PublicationHandler,
  plan: PublicationPlan,
): void {
  for (const effect of plan.effects) {
    if (effect.kind === GRAPH_COMPLETION_EFFECT) {
      if (handler.finishGraph === undefined) {
        throw new PublicationUnavailable('graph_completion_handler_unavailable');
      }
    } else if (!handler.effectKinds.includes(effect.kind)) {
      throw new PublicationUnavailable('publication_effect_handler_unavailable');
    }
  }
}

export function needsGraphCompletion(plan: PublicationPlan): boolean {
  return plan.effects.some((effect) => effect.kind === GRAPH_COMPLETION_EFFECT);
}
