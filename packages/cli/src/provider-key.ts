import {
  envFileValue,
  loadConfig,
  PROVIDER_KEY_ENV_VARS,
  resolveProviderRouting,
  unavailableReason,
  type Config,
  type GenerationProvider,
} from '@aion/core';

import { upsertEnvValue } from './install-profile.js';
import type { Writer } from './output.js';

/**
 * The service reads its provider and credential from `.env` on either install mode. Setup
 * records an exported or supplied key there; ordinary shell overrides affect only that CLI run.
 */
const GENERATION_ENV_VARS: readonly string[] = [
  'AION_GENERATION_PROVIDER',
  ...Object.values(PROVIDER_KEY_ENV_VARS),
];

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

/** The selected provider's credential; the other provider is never required. */
export type GenerationKey = {
  readonly provider: GenerationProvider;
  readonly envVar: string;
  readonly configured: string;
};

export function selectedProviderKey(config: Config): GenerationKey {
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

/** Missing credentials leave generation queued without blocking capture or installation. */
export async function resolveProviderKey(input: ProviderKeyInput): Promise<string | undefined> {
  const exported = input.exported.trim();
  if (exported !== '') {
    return exported;
  }
  if (input.assumeYes || !input.interactive) {
    return undefined;
  }
  const envVar = PROVIDER_KEY_ENV_VARS[input.provider];
  const answer = (await input.ask(`${input.provider} API key (${envVar}, Enter to skip): `)).trim();
  return answer === '' ? undefined : answer;
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
 * Returns the generation configuration the service will read. A recorded key stays unchanged;
 * an exported or supplied key is saved when none is recorded. Missing keys leave work queued.
 *
 * `env` is this run's environment: read for an exported key, and given the recorded one so the
 * config re-read carries it.
 */
export async function settleProviderKey(
  input: SettleKeyInput,
  env: NodeJS.ProcessEnv,
): Promise<Config> {
  const config = serviceGenerationConfig(input.envPath, env);
  const { provider, envVar, configured } = selectedProviderKey(config);
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
  if (key === undefined) {
    return config;
  }
  recordProviderKey(input.envPath, envVar, key, env);
  input.write(`${envVar} recorded in ${input.envPath}`);
  return serviceGenerationConfig(input.envPath, env);
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
    'queued until it is set. `aion init` records it; see docs/harness.md.',
  ];
}
