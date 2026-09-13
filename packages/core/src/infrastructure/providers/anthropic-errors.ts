import { summarizeErrorBody } from './errors.js';

/**
 * What a call to the Anthropic API can fail as. They live apart from the provider so the batch
 * client and the JSON reader can throw the same types without importing the provider that
 * imports them back.
 */

/** A non-2xx answer, after the retries. `status` is what a caller branches on. */
export class AnthropicRequestError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    // Capped and flattened, never carried whole: this message reaches the logs through every
    // `{ err }` call site, so a body that echoes the request would leak the episode text.
    super(`Anthropic request failed: ${String(status)} ${summarizeErrorBody(body)}`);
    this.name = 'AnthropicRequestError';
    this.status = status;
  }
}

/** A 2xx answer that carried no JSON value: no text block, or text no parse could read. */
export class AnthropicResponseError extends Error {
  constructor(detail: string) {
    super(`Anthropic response ${detail}`);
    this.name = 'AnthropicResponseError';
  }
}
