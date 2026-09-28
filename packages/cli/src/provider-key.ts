import {
  PROVIDER_KEY_ENV_VARS,
  resolveProviderRouting,
  unavailableReason,
  type Config,
  type GenerationProvider,
} from '@aion/core';

import { CliUsageError } from './args.js';

/**
 * The generation key `aion init` settles or reports. Its own module because it is a question about
 * the provider the installation selected rather than about the machine, and because `init.ts`
 * sits at the line cap.
 */

function missingProviderKey(provider: GenerationProvider): string {
  return (
    `the full profile needs ${PROVIDER_KEY_ENV_VARS[provider]} for AION_GENERATION_PROVIDER=${provider}. ` +
    'Set it in the environment or .env, or run `aion init full` from a terminal.'
  );
}

/** The key `full` settles: the selected provider's, which is Anthropic when nothing selects one. */
export type FullProfileKey = {
  readonly provider: GenerationProvider;
  readonly envVar: string;
  readonly configured: string;
};

export function fullProfileKey(config: Config): FullProfileKey {
  const { provider } = config.generation;
  return {
    provider,
    envVar: PROVIDER_KEY_ENV_VARS[provider],
    configured: provider === 'openai' ? config.openai.apiKey : config.anthropic.apiKey,
  };
}

export type ProviderKeyInput = {
  readonly provider: GenerationProvider;
  readonly configured: string;
  readonly fromEnvFile: string | undefined;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
};

/**
 * The key `aion init full` settles. It is asked for because generation runs only on the provider
 * `AION_GENERATION_PROVIDER` selects, and a profile promising generation with no credential for
 * that provider is a request nobody can serve. The other provider's key is never asked for, since
 * nothing reads it. Every other install needs no key for anything, hooks included.
 */
export async function resolveProviderKey(input: ProviderKeyInput): Promise<string> {
  const existing = (input.configured === '' ? (input.fromEnvFile ?? '') : input.configured).trim();
  if (existing !== '') {
    return existing;
  }
  if (input.assumeYes || !input.interactive) {
    throw new CliUsageError(missingProviderKey(input.provider));
  }
  const envVar = PROVIDER_KEY_ENV_VARS[input.provider];
  const answer = (await input.ask(`${input.provider} API key (${envVar}): `)).trim();
  if (answer === '') {
    throw new CliUsageError(missingProviderKey(input.provider));
  }
  return answer;
}

/**
 * What init says about the key once the hooks are in. Nothing when the selected provider has one.
 * Without it, the variable that selection needs, because hooks capture either way and an operator
 * reading "ready" should not have to learn from the queue depth that nothing is digesting.
 */
export function keyNoticeLines(config: Config): readonly string[] {
  const routing = resolveProviderRouting(config);
  if (routing.keyPresent) {
    return [];
  }
  return [
    `Generation waits for a key: ${unavailableReason(routing)}. Captures are stored and`,
    'queued until it is set. `aion init full` records it; see docs/harness.md.',
  ];
}
