import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { KnobTable } from './knobs.js';
import { buildRegistry, envVarForPath, KNOB_REGISTRY, knownEnvVars } from './registry.js';

describe('knob registry', () => {
  it('refuses a table where two leaves claim one variable, naming both paths', () => {
    const table: KnobTable = {
      recall: { maxHops: ['AION_TWICE', z.number(), 3] },
      search: { rrfConstant: ['AION_TWICE', z.number(), 60] },
    };

    expect(() => buildRegistry(table)).toThrow(
      'AION_TWICE is declared by both recall.maxHops and search.rrfConstant',
    );
  });

  it('gives every shipped knob its own variable', () => {
    expect(knownEnvVars().size).toBe(KNOB_REGISTRY.length);
  });

  it('resolves a path that points inside a subtree leaf to that leaf variable', () => {
    expect(envVarForPath(['search', 'weights'])).toBe('AION_SEARCH_WEIGHTS');
    expect(envVarForPath(['search', 'weights', 'vector'])).toBe('AION_SEARCH_WEIGHTS');
    expect(envVarForPath(['search', 'methods', '1'])).toBe('AION_SEARCH_METHODS');
    expect(envVarForPath(['search', 'nothing'])).toBeUndefined();
  });
});
