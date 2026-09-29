import { embedPrefix, maxEmbedInputChars } from './embed-models.js';
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
 * Ollama's refusal of an input longer than the window it runs the model at. It names no code,
 * so the message is what identifies it: "the input length exceeds the context length" on 0.33,
 * "input length exceeds maximum context length" on earlier releases.
 */
function exceedsContext(err: unknown): boolean {
  return (
    err instanceof OllamaRequestError && err.status === 400 && /context length/i.test(err.message)
  );
}

/**
 * The local embedder, over Ollama's HTTP API. It has no `generate`: every generation runs on
 * the remote model, and the embedding model is the vector index rather than a route.
 *
 * Long text embeds from its prefix: the model's cap here, and Ollama's own truncation within it
 * (`embed-models.ts`). Every embed in the product passes through this class, so the bound on
 * what reaches Ollama lives here and nowhere else.
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

  /**
   * One vector per text, in order. A request Ollama refuses as over-length is sent again one
   * input at a time, because the refusal fails every input and names none: only the input that
   * draws it again is shortened, and the rest are sent unchanged. Any other failure, or an input
   * refused however short it gets, throws, so no caller records a vector it does not have.
   */
  async embed(texts: readonly string[]): Promise<Vector[]> {
    if (texts.length === 0) {
      return [];
    }

    const inputs = texts.map((text) => embedPrefix(foldForEmbedding(text), this.embedInputCap));
    try {
      return await this.request(inputs);
    } catch (err) {
      if (!exceedsContext(err)) {
        throw err;
      }
    }
    const vectors: Vector[] = [];
    for (const input of inputs) {
      vectors.push(await this.embedFitting(input));
    }
    return vectors;
  }

  /** One input, halved each time Ollama refuses it as over-length, until it fits. */
  private async embedFitting(input: string): Promise<Vector> {
    let text = input;
    for (;;) {
      try {
        const [vector] = await this.request([text]);
        if (vector === undefined) {
          throw new Error('Ollama embed response missing or mismatched embeddings');
        }
        return vector;
      } catch (err) {
        const shorter = embedPrefix(text, Math.floor(text.length / 2));
        if (!exceedsContext(err) || shorter.length === 0) {
          throw err;
        }
        text = shorter;
      }
    }
  }

  private async request(inputs: readonly string[]): Promise<Vector[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.embedModel,
        input: inputs,
        ...(this.embedKeepAlive === undefined ? {} : { keep_alive: this.embedKeepAlive }),
      }),
    });
    if (!response.ok) {
      throw new OllamaRequestError('embed', response.status, await response.text());
    }

    const body = (await response.json()) as { embeddings?: number[][] };
    if (body.embeddings?.length !== inputs.length) {
      throw new Error('Ollama embed response missing or mismatched embeddings');
    }
    return body.embeddings;
  }
}
