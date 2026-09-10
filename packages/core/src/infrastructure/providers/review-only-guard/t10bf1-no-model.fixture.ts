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

// Where the audit lands. A copied absolute path writes one reviewer's round into every later run
// and cannot be read on another machine at all, so the destination is named by the environment and
// falls back to a path inside this repository.
const AUDIT_PATH = process.env.AION_NO_MODEL_AUDIT ?? 'no-model-audit.jsonl';

afterAll(() => {
  const record = {
    event: 'no_model_audit',
    root: expect.getState().testPath,
    attempts: audit.attempts,
  };
  appendFileSync(AUDIT_PATH, `${JSON.stringify(record)}\n`);
  console.log(JSON.stringify(record));
  expect(audit.attempts).toEqual([]);
});
