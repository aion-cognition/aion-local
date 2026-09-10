import { expect, it } from 'vitest';

import { OllamaProvider } from '../ollama-provider.js';

it('cannot turn a caught backend-construction refusal into passing evidence', () => {
  expect(
    () => new OllamaProvider({ embedModel: 'must-never-run', baseUrl: 'http://127.0.0.1:0' }),
  ).toThrow('model construction is forbidden');
});
