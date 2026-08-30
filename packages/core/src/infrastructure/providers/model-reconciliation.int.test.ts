import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../config/defaults.js';
import type { Config } from '../config/schema.js';
import { listResidentModels, reconcileResidentModels } from './model-reconciliation.js';
import { listOllamaModels } from './provisioning.js';
import { resolveProviderRouting } from './routing.js';

const BASE_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';

/**
 * The small instruct model both roles name here, so one load and one unload cover the whole
 * flip. The 8B reflect model would prove the same thing and cost a minute of disk read.
 */
const CHAT_MODEL = DEFAULTS.models.cue;

function config(apiKey: string): Config {
  return {
    ...DEFAULTS,
    ollama: { ...DEFAULTS.ollama, url: BASE_URL },
    models: { ...DEFAULTS.models, cue: CHAT_MODEL, reflect: CHAT_MODEL },
    anthropic: { ...DEFAULTS.anthropic, apiKey },
  };
}

function normalized(names: readonly string[]): string[] {
  return names.map((name) => (name.includes(':') ? name : `${name}:latest`));
}

async function residentNames(): Promise<string[]> {
  return normalized((await listResidentModels(BASE_URL)).map((model) => model.name));
}

/** An empty prompt is Ollama's load call: the weights come in, no tokens are generated. */
async function loadModel(model: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 300, stream: false }),
  });
  expect(response.ok).toBe(true);
  await response.text();
}

async function loadEmbedModel(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: DEFAULTS.models.embed, input: ['reconciliation probe'] }),
  });
  expect(response.ok).toBe(true);
  await response.text();
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return true;
    }
    if (Date.now() > deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('reconciling live Ollama memory against the key', () => {
  it(
    'unloads the instruct model the key covers, keeps the embed model, and leaves the disk alone',
    async () => {
      // Sorted, because `/api/tags` is a set and not a sequence: loading a model moves it in
      // the order Ollama returns, which is the thing this test is about to do twice.
      const installedBefore = [...(await listOllamaModels(BASE_URL))].sort();
      await loadModel(CHAT_MODEL);
      await loadEmbedModel();
      expect(await residentNames()).toContain(`${CHAT_MODEL}`);

      const withKey = await reconcileResidentModels({
        baseUrl: BASE_URL,
        routing: resolveProviderRouting(config('sk-ant-live-flip')),
      });

      expect(withKey.checked).toBe(true);
      expect(withKey.error).toBeUndefined();
      expect(withKey.evicted).toContain(CHAT_MODEL);
      expect(await waitUntil(async () => !(await residentNames()).includes(CHAT_MODEL))).toBe(true);
      // The vector index runs under every route, so its model is never a candidate.
      expect(await residentNames()).toContain(`${DEFAULTS.models.embed}:latest`);
      // Unloading is a memory operation: every tag that was installed is still installed.
      expect([...(await listOllamaModels(BASE_URL))].sort()).toEqual(installedBefore);
    },
    180_000,
  );

  it(
    'touches nothing once the key is gone, and the model loads again with no pull',
    async () => {
      const local = await reconcileResidentModels({
        baseUrl: BASE_URL,
        routing: resolveProviderRouting(config('')),
      });

      expect(local.checked).toBe(false);
      expect(local.evicted).toEqual([]);

      // What "disk untouched" buys: the local route works again immediately.
      await loadModel(CHAT_MODEL);
      expect(await residentNames()).toContain(CHAT_MODEL);

      const stillLocal = await reconcileResidentModels({
        baseUrl: BASE_URL,
        routing: resolveProviderRouting(config('')),
      });
      expect(stillLocal.evicted).toEqual([]);
      expect(await residentNames()).toContain(CHAT_MODEL);
    },
    180_000,
  );
});
