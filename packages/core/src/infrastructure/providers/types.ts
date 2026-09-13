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
  signal?: AbortSignal;
  /**
   * Whether the model reasons before it answers. `true` turns on Haiku 4.5's extended thinking
   * with an explicit token budget. That model takes no adaptive mode, so the budget is a request
   * field rather than an effort word. Anything but `true` sends no thinking configuration, which
   * is the model's own default of off.
   *
   * Extraction tasks set this false; a caller that wants the model to reason sets it true.
   */
  think?: boolean;
};

/**
 * Which rate card a response is billed on. Batched requests bill at half the ordinary rate for
 * the same token counts, so the discount belongs here and never in the counts themselves: a
 * halved token total would read as a smaller request on every report that is not about money.
 */
export type ApiPricingTier = 'standard' | 'batch';

/** Usage reported by one billed API response; the input token classes do not overlap. */
export type ApiCall = {
  readonly occurredAt: Date;
  readonly model: string;
  readonly surface: string;
  /**
   * The remote request this usage is for, where the route names one. It is the identity a bill
   * is recorded once under: a batch is read again on every settlement pass, and a second row per
   * reading would charge one answer as many times as it was polled.
   *
   * Absent on the synchronous route, where one call is one response and there is nothing to poll.
   */
  readonly requestId?: string;
  /** Absent means `standard`, which is what every synchronous call is. */
  readonly pricingTier?: ApiPricingTier;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationTokens: number;
  readonly cacheReadTokens: number;
  /**
   * The share of `outputTokens` the model spent reasoning. Inside the output count rather than
   * beside it, so a total must never add the two: the API bills thinking as output, and this
   * says how much of that bill the reasoning was.
   *
   * Absent where the response carried no breakdown, which is the honest reading: the totals
   * beside it are still known, and only the split inside the output count is missing.
   */
  readonly thinkingTokens?: number;
  readonly durationMs: number;
  readonly attempts: number;
  /** Token counters are placeholders when the billed response has no valid usage block. */
  readonly usageError?: 'invalid_usage';
};

/**
 * The local half. Embeddings never leave the machine: one model owns the vector space for the
 * life of a substrate, so a call site that only embeds asks for this rather than for a whole
 * provider it would never generate through.
 */
export type Embedder = {
  embed(texts: readonly string[]): Promise<Vector[]>;
};

/**
 * `embed` runs locally; `generate` leaves the machine for the Anthropic API. One interface
 * covers both so callers never branch on which implementation is behind it.
 */
export type Provider = Embedder & {
  generate(req: StructuredRequest): Promise<unknown>;
  /**
   * Where `generate` resolved, for a call site that sizes its own prompt to the model behind it.
   * Structural rather than the routing layer's own type, so this module stays free of that
   * import and no existing implementation grows a field. An absent route is a test fake, which
   * gets the small-model prompt shapes.
   */
  readonly route?: { readonly provider: 'anthropic' };
};

/**
 * Half a provider: what the remote route offers. Anthropic has no embeddings API, so the
 * routing layer pairs one of these with the local embedder rather than letting a second
 * implementation of `Provider` exist without `embed`.
 */
export type GenerationBackend = Pick<Provider, 'generate'>;
