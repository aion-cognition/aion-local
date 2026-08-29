import type { ChatMessage, StructuredRequest } from '../../../infrastructure/providers/types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export type AnthropicClientOptions = {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxTokens?: number;
};

type AnthropicMessage = { role: 'user' | 'assistant'; content: string };

/** Anthropic takes system instructions as a top-level string, not a `system`-role message. */
function splitSystem(messages: readonly ChatMessage[]): {
  system: string | undefined;
  rest: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const rest: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content);
      continue;
    }
    rest.push({ role: message.role, content: message.content });
  }
  return { system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, rest };
}

/**
 * Minimal structured-output caller for `claude-haiku-4-5` (Messages API, raw HTTP). The
 * quality harness's own comparison route, not the production Anthropic `Provider`. Embeddings
 * stay local regardless of route, so the `embed` method is not here.
 */
export class AnthropicHaikuClient {
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #maxTokens: number;

  constructor(options: AnthropicClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async generate(req: StructuredRequest): Promise<unknown> {
    const { system, rest } = splitSystem(req.messages);
    const response = await this.#fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.#apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens ?? this.#maxTokens,
        ...(system === undefined ? {} : { system }),
        output_config: { format: { type: 'json_schema', schema: req.schema } },
        messages: rest,
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
    if (!response.ok) {
      throw new Error(`Anthropic generate request failed: ${response.status} ${await response.text()}`);
    }

    const body = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
    const textBlock = body.content?.find((block) => block.type === 'text');
    if (textBlock?.text === undefined) {
      throw new Error('Anthropic generate response missing text content');
    }
    return JSON.parse(textBlock.text) as unknown;
  }
}
