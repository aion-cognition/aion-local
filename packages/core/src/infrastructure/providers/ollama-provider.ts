import { OllamaRequestError } from './errors.js';
import type { Provider, StructuredRequest, Vector } from './types.js';
import { foldForIdentity } from './unicode-fold.js';

export type OllamaProviderOptions = {
  baseUrl: string;
  embedModel: string;
  fetchImpl?: typeof fetch;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * `foldForIdentity` is the same fold `name_norm` is derived through, which is what keeps a
 * stored vector and a query vector on the same footing. Folding here rather than at a call
 * site is deliberate: an asymmetric fold would score a document against a differently
 * tokenized query. See `unicode-fold.ts` for what the fold does and why.
 */
function foldForEmbedding(text: string): string {
  return foldForIdentity(text);
}

/**
 * nomic-bert's trained context is 2048 tokens, and Ollama enforces that ceiling on every
 * /api/embed call. One input over the limit fails the whole batch with a 400, not just the
 * offending row, so an oversized node stalls every node queued with it. Cap at ~4 chars per
 * token with headroom for denser technical text and the model's special tokens.
 */
const MAX_EMBED_INPUT_CHARS = 6000;

function capForEmbedding(text: string): string {
  return text.length > MAX_EMBED_INPUT_CHARS ? text.slice(0, MAX_EMBED_INPUT_CHARS) : text;
}

/**
 * Local-only implementation of `Provider` over Ollama's HTTP API. `generate` always
 * sets the chat `format` field to the caller's JSON Schema (structured output), kept
 * generic here since the caller that drives it belongs to a later stage of the pipeline.
 */
export class OllamaProvider implements Provider {
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.embedModel = options.embedModel;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embed(texts: readonly string[]): Promise<Vector[]> {
    if (texts.length === 0) {
      return [];
    }

    const response = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.embedModel,
        input: texts.map((text) => capForEmbedding(foldForEmbedding(text))),
      }),
    });
    if (!response.ok) {
      throw new OllamaRequestError('embed', response.status, await response.text());
    }

    const body = (await response.json()) as { embeddings?: number[][] };
    if (body.embeddings?.length !== texts.length) {
      throw new Error('Ollama embed response missing or mismatched embeddings');
    }
    return body.embeddings;
  }

  async generate(req: StructuredRequest): Promise<unknown> {
    const modelOptions: Record<string, number> = {};
    if (req.maxTokens !== undefined) {
      modelOptions.num_predict = req.maxTokens;
    }
    if (req.temperature !== undefined) {
      modelOptions.temperature = req.temperature;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        format: req.schema,
        stream: false,
        ...(req.think === undefined ? {} : { think: req.think }),
        ...(Object.keys(modelOptions).length > 0 ? { options: modelOptions } : {}),
      }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
    });
    if (!response.ok) {
      throw new OllamaRequestError('generate', response.status, await response.text());
    }

    const body = (await response.json()) as { message?: { content?: string } };
    const content = body.message?.content;
    if (content === undefined) {
      throw new Error('Ollama generate response missing message content');
    }
    return JSON.parse(content) as unknown;
  }
}
