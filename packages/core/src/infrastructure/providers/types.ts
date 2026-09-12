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
  /** The stage or operation charged for this generation call. */
  readonly surface?: string;
  model: string;
  messages: readonly ChatMessage[];
  schema: JsonSchema;
  maxTokens?: number;
  temperature?: number;
  /**
   * `options.num_ctx` on the local provider: the context window this call is served under. The
   * provider sends it on every role-routed generation and never trusts the model's own default,
   * because that default is not one number. Ollama documents 4096 in its FAQ, 2048 in the
   * Modelfile reference and a VRAM-derived value elsewhere, and overrunning it truncates in
   * silence: measured 2026-09-08, a 5,234-token prompt sent at num_ctx 4096 came back reporting
   * prompt_eval_count 4096, with 1,138 tokens dropped, no error and no warning. A judge reading a
   * truncated record still answers, and answers confidently. The role's knob supplies the value;
   * a caller that sizes its own call class may name one instead. Anthropic has no equivalent
   * setting and ignores it.
   */
  numCtx?: number;
  signal?: AbortSignal;
  /**
   * Hybrid reasoning models (the qwen3 family) emit a reasoning block ahead of the
   * structured answer unless it is switched off, and that block dominates the call:
   * measured on host Ollama, `qwen3:1.7b` runs 527-937ms warm with reasoning off against
   * a 1.9-11.3s spread with it on, plus calls that never return at all. Extraction tasks
   * set this false; a caller that wants the model to reason leaves it unset.
   */
  think?: boolean;
};

/** Usage reported by one billed API response; the input token classes do not overlap. */
export type ApiCall = {
  readonly occurredAt: Date;
  readonly model: string;
  readonly surface: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  readonly durationMs: number;
  readonly attempts: number;
  /** Token counters are placeholders when the billed response has no valid usage block. */
  readonly usageError?: 'invalid_usage';
};

/**
 * `embed` always runs locally; `generate` is provider-routed and may leave the machine when
 * an Anthropic key is set. One interface covers both so callers never branch on which
 * implementation is behind it.
 */
export type Provider = {
  embed(texts: readonly string[]): Promise<Vector[]>;
  generate(req: StructuredRequest): Promise<unknown>;
  /**
   * Where `generate` resolved, for a call site that sizes its own prompt to the model behind it.
   * Structural rather than the routing layer's own type, so this module stays free of that
   * import and no existing implementation grows a field. An absent route reads as local: a test
   * fake or a bare `OllamaProvider` gets the small-model behavior.
   */
  readonly route?: { readonly provider: 'ollama' | 'anthropic' };
};

/**
 * Half a provider: what a remote route can offer. Anthropic has no embeddings API, and the
 * embedding model is the vector index, so the routing layer pairs one of these with the local
 * embedder rather than letting a second implementation of `Provider` exist without `embed`.
 */
export type GenerationBackend = Pick<Provider, 'generate'>;
