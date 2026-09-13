import { describe, expect, it } from 'vitest';

import { listResidentModels, reconcileResidentModels } from './model-reconciliation.js';
import { listOllamaModels } from './provisioning.js';
import { DEFAULTS } from '../config/defaults.js';

const BASE_URL = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = DEFAULTS.models.embed;

function normalized(names: readonly string[]): string[] {
  return names.map((name) => (name.includes(':') ? name : `${name}:latest`));
}

async function residentNames(): Promise<string[]> {
  return normalized((await listResidentModels(BASE_URL)).map((model) => model.name));
}

async function loadEmbedModel(): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: ['reconciliation probe'] }),
  });
  expect(response.ok).toBe(true);
  await response.text();
}

/**
 * What reconciliation is for now that generation is remote: reading whether the one model this
 * substrate asks Ollama for is warm, and touching nothing else the machine is holding.
 */
describe('reconciling live Ollama memory against the embedding model', () => {
  it('reports the embedding model resident after an embed, and unloads nothing', async () => {
    const installedBefore = [...(await listOllamaModels(BASE_URL))].sort();
    await loadEmbedModel();

    const report = await reconcileResidentModels({ baseUrl: BASE_URL, embedModel: EMBED_MODEL });

    expect(report.checked).toBe(true);
    expect(report.error).toBeUndefined();
    expect(report.embedResident).toBe(true);
    // Reading residency is a read: everything that was installed still is.
    expect(await residentNames()).toContain(`${EMBED_MODEL}:latest`);
    expect([...(await listOllamaModels(BASE_URL))].sort()).toEqual(installedBefore);
  }, 180_000);

  it('leaves every other resident model where it is', async () => {
    await loadEmbedModel();
    const before = [...(await residentNames())].sort();

    await reconcileResidentModels({ baseUrl: BASE_URL, embedModel: EMBED_MODEL });

    expect([...(await residentNames())].sort()).toEqual(before);
  }, 180_000);
});
