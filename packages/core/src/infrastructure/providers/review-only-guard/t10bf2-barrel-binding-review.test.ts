import { expect, it, vi } from 'vitest';

import { OllamaProvider as FromBarrel } from '@aion/core';

import { OllamaProvider as Direct } from '../ollama-provider.js';

it('guards the same backend constructor that the workspace barrel exports', () => {
  expect.soft(vi.isMockFunction(FromBarrel)).toBe(true);
  expect(FromBarrel).toBe(Direct);
});
