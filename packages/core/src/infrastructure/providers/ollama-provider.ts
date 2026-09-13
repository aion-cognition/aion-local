import { maxEmbedInputChars } from './embed-models.js';
import { OllamaRequestError } from './errors.js';
import type { Embedder, Vector } from './types.js';
import { foldForIdentity } from '../../reflection/domain/name-fold.js';

export type OllamaProviderOptions = {
  baseUrl: string;
  embedModel: string;
  /** Sent as `keep_alive` on embed calls; -1 keeps the model resident. Omitted, the server's own default applies. */
  embedKeepAlive?: number;
  fetchImpl?: typeof fetch;
};

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * `foldForIdentity` is the same fold `name_norm` is derived through, which is what keeps a
 * stored vector and a query vector on the same footing. Folding here rather than at a call
 * site is deliberate: an asymmetric fold would score a document against a differently
 * tokenized query. See `name-fold.ts` for what the fold does and why.
 */
function foldForEmbedding(text: string): string {
  return foldForIdentity(text);
}

/**
 * The budget belongs to the model, so it is read from the model's row rather than pinned here.
 * `embed-models.ts` carries the window and the derivation. Long text embeds from its prefix;
 * windowing the remainder into a pooled vector is a later enhancement.
 */
function capForEmbedding(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * The local embedder, over Ollama's HTTP API. It has no `generate`: every generation runs on
 * the remote model, and the embedding model is the vector index rather than a route.
 */
export class OllamaProvider implements Embedder {
  private readonly baseUrl: string;
  private readonly embedModel: string;
  private readonly embedInputCap: number;
  private readonly embedKeepAlive: number | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.embedModel = options.embedModel;
    this.embedInputCap = maxEmbedInputChars(options.embedModel);
    this.embedKeepAlive = options.embedKeepAlive;
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
        input: texts.map((text) => capForEmbedding(foldForEmbedding(text), this.embedInputCap)),
        ...(this.embedKeepAlive === undefined ? {} : { keep_alive: this.embedKeepAlive }),
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
}
