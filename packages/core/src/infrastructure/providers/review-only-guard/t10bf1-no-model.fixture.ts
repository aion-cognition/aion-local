import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, expect, vi } from 'vitest';

import type * as AnthropicModule from '../anthropic-provider.js';
import type * as OllamaModule from '../ollama-provider.js';

const audit = vi.hoisted(() => ({ attempts: [] as string[] }));

vi.mock('../ollama-provider.js', async (original) => {
  const module = await original<typeof OllamaModule>();
  return {
    ...module,
    OllamaProvider: vi.fn(function forbiddenOllamaConstruction() {
      audit.attempts.push('OllamaProvider');
      throw new Error('model construction is forbidden in this reviewed unit run');
    }),
  };
});

vi.mock('../anthropic-provider.js', async (original) => {
  const module = await original<typeof AnthropicModule>();
  return {
    ...module,
    AnthropicProvider: vi.fn(function forbiddenAnthropicConstruction() {
      audit.attempts.push('AnthropicProvider');
      throw new Error('model construction is forbidden in this reviewed unit run');
    }),
  };
});

vi.stubGlobal('fetch', () => {
  audit.attempts.push('fetch');
  throw new Error('HTTP is forbidden in this reviewed unit run');
});

afterEach(() => {
  expect(audit.attempts, 'caught model attempts still invalidate this run').toEqual([]);
});

afterAll(() => {
  const record = {
    event: 'no_model_audit',
    root: expect.getState().testPath,
    attempts: audit.attempts,
  };
  appendFileSync(
    '/Users/rhuber/Documents/not-solace-code/aion_code/campaign-artifacts/impl-2026-09-07/t10bf1-astra-cli-audit.jsonl',
    `${JSON.stringify(record)}\n`,
  );
  console.log(JSON.stringify(record));
  expect(audit.attempts).toEqual([]);
});
