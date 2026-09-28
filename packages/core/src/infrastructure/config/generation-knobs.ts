import { z } from 'zod';

import { text } from './knob-types.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_REASONING_EFFORTS } from '../providers/openai-provider.js';
import { GENERATION_PROVIDERS } from '../providers/types.js';

const provider = z.enum(GENERATION_PROVIDERS);

/**
 * Which remote API each generation role runs on, and the OpenAI route's own settings. Split out of
 * `knobs.ts` the way `maintenance` is, since that file sits near the line cap.
 *
 * The choice is explicit per role and nothing chooses for the operator: a role whose provider has
 * no key is unavailable, and its work queues or its recall falls back to the existing ranking and
 * says so. It is never quietly sent to the other provider, because a comparison between the two
 * would then be measuring whichever one happened to have a key.
 */
export const GENERATION_KNOBS = {
  // The recall role: the one generation on the hot path, which assesses what retrieval found (or,
  // in the `cues` recall mode, extracts search cues).
  recallProvider: ['AION_RECALL_PROVIDER', provider, 'anthropic'],
  // Every background generation: reflection stages and judgments, narratives, and introspection's
  // model calls. Batched description refresh runs only on the Anthropic batch route, so it pauses
  // while this is anything else, and says so in its operation detail.
  reflectProvider: ['AION_REFLECT_PROVIDER', provider, 'anthropic'],
} as const;

export const OPENAI_KNOBS = {
  /** Empty means the OpenAI route is unavailable. A role pinned to it then waits for a key. */
  apiKey: ['AION_OPENAI_API_KEY', z.string(), ''],
  /** The model every OpenAI-routed generation names, whatever model the caller asked for. */
  model: ['AION_OPENAI_MODEL', text, DEFAULT_OPENAI_MODEL],
  // The reasoning effort a call that asked to think is sent at. A call that did not ask sends
  // `none`, which is also the only setting that accepts a temperature. Low is the Anthropic
  // route's analogue: there a thinking call gets a 2,048-token budget inside its answer ceiling,
  // and GPT-6 Luna's own default is medium.
  reasoningEffort: ['AION_OPENAI_REASONING_EFFORT', z.enum(OPENAI_REASONING_EFFORTS), 'low'],
} as const;
