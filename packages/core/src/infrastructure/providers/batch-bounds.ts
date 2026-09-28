import { boundApiCost } from './api-pricing.js';
import type { BatchTransport } from './batch-transport.js';
import type { CacheWriteClass } from './request-blocks.js';
import { boundedTokens } from './spending.js';
import type { GenerationProvider } from './types.js';
import type { BatchWorkItem } from '../sqlite/batch-work.js';

/**
 * The most a set of batched requests can cost, read off the stored bodies through the transport
 * that knows their shape.
 *
 * Every request in a batch names the substrate's one configured generation model, so the whole
 * set prices on that model: the batch is built from one surface's own requests, and the producer
 * encodes the same model into all of them. The token bound is each request's own serialized body
 * and the output ceiling it names, summed. The write class is the dearest any of the bodies can be
 * billed at, since one hold bounds the whole batch. The provider is what an unlisted model is
 * bounded on: each vendor's own card.
 */
export function batchHoldBound(
  transport: BatchTransport,
  items: readonly BatchWorkItem[],
): CacheWriteClass & {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly provider: GenerationProvider;
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let model = 'unknown';
  let held: CacheWriteClass = { cacheWrite: false };
  for (const item of items) {
    const request = transport.bound(item.request);
    if (request.model !== undefined && model === 'unknown') {
      ({ model } = request);
    }
    const bound = boundedTokens(
      Buffer.byteLength(JSON.stringify(item.request), 'utf8'),
      request.outputTokens,
    );
    inputTokens += bound.inputTokens;
    outputTokens += bound.outputTokens;
    const { cacheWrite, cacheWriteTtl } = request;
    if (cacheWrite && (!held.cacheWrite || cacheWriteTtl === '1h')) {
      held = { cacheWrite, ...(cacheWriteTtl === undefined ? {} : { cacheWriteTtl }) };
    }
  }
  return { model, inputTokens, outputTokens, ...held, provider: transport.provider };
}

/** The same bound in dollars, at the batch rate. */
export function batchBoundUsd(transport: BatchTransport, items: readonly BatchWorkItem[]): number {
  return boundApiCost({ ...batchHoldBound(transport, items), pricingTier: 'batch' }).maxUsd;
}
