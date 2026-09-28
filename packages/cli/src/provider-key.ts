import {
  envFileValue,
  loadConfig,
  PROVIDER_KEY_ENV_VARS,
  resolveProviderRouting,
  unavailableReason,
  type Config,
  type GenerationProvider,
} from '@aion/core';

import { CliUsageError } from './args.js';
import { upsertEnvValue } from './install-profile.js';
import type { Writer } from './output.js';

/**
 * The generation key `aion init` settles or reports. Its own module because it is a question about
 * the provider the installation selected rather than about the machine, and because `init.ts`
 * sits at the line cap.
 *
 * Both questions are answered from `.env`, because that file is all the service reads for them:
 * compose passes none of these variables through from the shell, and the launchd job carries only
 * what the file records. A native CLI run sees its shell's exports over the file, so its own config
 * can hold a key the service will never get.
 */
const GENERATION_ENV_VARS: readonly string[] = [
  'AION_GENERATION_PROVIDER',
  ...Object.values(PROVIDER_KEY_ENV_VARS),
];

function missingProviderKey(provider: GenerationProvider): string {
  return (
    `the full profile needs ${PROVIDER_KEY_ENV_VARS[provider]} for AION_GENERATION_PROVIDER=${provider}. ` +
    'Set it in the environment or .env, or run `aion init full` from a terminal.'
  );
}

/**
 * Config as the service will read it: `env`, with the generation variables taken from `.env` and
 * nowhere else. An empty value counts as unset, the way the launchd job drops one.
 */
export function serviceGenerationConfig(envPath: string, env: NodeJS.ProcessEnv): Config {
  const view: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) => !GENERATION_ENV_VARS.includes(name)),
  );
  for (const name of GENERATION_ENV_VARS) {
    const recorded = envFileValue(envPath, name);
    if (recorded !== undefined && recorded.trim() !== '') {
      view[name] = recorded;
    }
  }
  return loadConfig(view);
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
  /** The key this run's environment holds, which is not yet the service's. */
  readonly exported: string;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
};

/**
 * The key `aion init full` records when `.env` has none. It is asked for because generation runs
 * only on the provider `AION_GENERATION_PROVIDER` selects, and a profile promising generation with
 * no credential for that provider is a request nobody can serve. The other provider's key is never
 * asked for, since nothing reads it. Every other install needs no key for anything, hooks included.
 */
export async function resolveProviderKey(input: ProviderKeyInput): Promise<string> {
  const exported = input.exported.trim();
  if (exported !== '') {
    return exported;
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
 * Writes the key to `.env` and to `out`, which is what the config re-read after it sees. The name
 * is also what `no-param-reassign` accepts a property assignment through.
 */
function recordProviderKey(
  envPath: string,
  envVar: string,
  key: string,
  out: NodeJS.ProcessEnv,
): void {
  upsertEnvValue(envPath, envVar, key);
  out[envVar] = key;
}

export type SettleKeyInput = {
  readonly envPath: string;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
  readonly write: Writer;
};

/**
 * Makes sure the service boots with the selected provider's key, and returns the config the rest
 * of the run reads. A key `.env` already holds is left alone, whatever the shell exports. A key
 * only the shell holds is recorded, since the service would never see it otherwise.
 *
 * `env` is this run's environment: read for an exported key, and given the recorded one so the
 * config re-read carries it.
 */
export async function settleProviderKey(
  config: Config,
  input: SettleKeyInput,
  env: NodeJS.ProcessEnv,
): Promise<Config> {
  const { provider, envVar, configured } = fullProfileKey(
    serviceGenerationConfig(input.envPath, env),
  );
  if (configured.trim() !== '') {
    return config;
  }
  const key = await resolveProviderKey({
    provider,
    exported: env[envVar] ?? '',
    assumeYes: input.assumeYes,
    interactive: input.interactive,
    ask: input.ask,
  });
  recordProviderKey(input.envPath, envVar, key, env);
  input.write(`${envVar} recorded in ${input.envPath}`);
  return loadConfig(env);
}

/**
 * What init says about the key once the hooks are in. Nothing when the service will have the
 * selected provider's key. Without it, the variable that selection needs, because hooks capture
 * either way and an operator reading "ready" should not have to learn from the queue depth that
 * nothing is digesting.
 */
export function keyNoticeLines(envPath: string, env: NodeJS.ProcessEnv): readonly string[] {
  const routing = resolveProviderRouting(serviceGenerationConfig(envPath, env));
  if (routing.keyPresent) {
    return [];
  }
  return [
    `Generation waits for a key: ${unavailableReason(routing)}. Captures are stored and`,
    'queued until it is set. `aion init full` records it; see docs/harness.md.',
  ];
}
