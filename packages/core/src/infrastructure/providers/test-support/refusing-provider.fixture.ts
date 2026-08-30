import type { Provider, Vector } from '../types.js';

/**
 * For a caller that must not reach a model. Both calls reject rather than answer, so a test
 * whose subject starts generating fails on the call itself instead of on whatever a stub
 * answer would have produced downstream.
 */
export const refusingProvider: Provider = {
  embed: (): Promise<Vector[]> => Promise.reject(new Error('this caller must not embed')),
  generate: (): Promise<unknown> => Promise.reject(new Error('this caller must not generate')),
};
