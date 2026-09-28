import { z } from 'zod';

import { text } from './knob-types.js';
import { DEFAULT_OPENAI_MODEL, OPENAI_REASONING_EFFORTS } from '../providers/openai-provider.js';
import { GENERATION_PROVIDERS } from '../providers/types.js';

const provider = z.enum(GENERATION_PROVIDERS);

/**
 * Which remote API the substrate's hosted generation runs on, and the OpenAI route's own settings.
 * Split out of `knobs.ts` the way `maintenance` is, since that file sits near the line cap.
 *
 * One choice for the whole installation: recall assessment, reflection, model-assisted
 * introspection and batched description refresh all run on the selected provider, and only that
 * vendor's key is needed. A selected provider with no key is unavailable, and its work queues or
 * its recall falls back to the existing ranking and says so. It is never quietly sent to the other
 * provider. Absent, the selector reads as Anthropic, which is every installation made before it
 * existed.
 */
export const GENERATION_KNOBS = {
  provider: ['AION_GENERATION_PROVIDER', provider, 'anthropic'],
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
