export type Vector = readonly number[];

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * A JSON Schema object, passed through verbatim to the provider's structured-output
 * mode. Left untyped beyond `Record<string, unknown>` so this module carries no
 * dependency on a particular schema builder.
 */
export type JsonSchema = Record<string, unknown>;

export type StructuredRequest = {
  model: string;
  messages: readonly ChatMessage[];
  schema: JsonSchema;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Hybrid reasoning models (the qwen3 family this build pins) emit a reasoning block ahead
   * of the structured answer unless it is switched off, and that block dominates the call:
   * measured on host Ollama, `qwen3:1.7b` runs 527-937ms warm with reasoning off against a
   * 1.9-11.3s spread with it on, plus calls that never return at all. Extraction tasks set
   * this false; a caller that wants the model to reason leaves it unset.
   */
  think?: boolean;
};

/**
 * PRD §10: `embed` always runs locally; `generate` is provider-routed and may leave
 * the machine once the Anthropic provider lands (deferred to P3+, per the plan's
 * cross-phase deferral list). One interface covers both so callers never branch on
 * which implementation is behind it.
 */
export type Provider = {
  embed(texts: readonly string[]): Promise<Vector[]>;
  generate(req: StructuredRequest): Promise<unknown>;
};
