import { describe, expect, it } from 'vitest';

import { resonantItem } from './resonance.js';
import { assemble } from './test-support/pack.fixture.js';
import type { SeedCandidate } from '../../infrastructure/graph/seed-queries.js';

describe('inference qualifications survive the resonance conversion', () => {
  for (const contested of [false, true]) {
    it(`preserves synthesis standing (contested=${String(contested)})`, () => {
      const candidate: SeedCandidate = {
        id: 'synthesis',
        labels: ['Synthesis', 'Memory'],
        content: 'the cache explains the slowdown',
        currency: 'current',
        ...(contested ? { contested: true as const } : {}),
      };
      const resonant = resonantItem(candidate, 0.9);
      const pack = assemble([], { resonant: [resonant] });
      expect(pack.resonant).toHaveLength(1);
      if (contested) {
        expect(pack.resonant?.[0]?.standing?.contested).toBe(true);
        expect(pack.rendered_text).toContain('contested');
      } else {
        expect(pack.resonant?.[0]?.standing?.contested).toBeUndefined();
      }
    });
  }
  for (const context of [undefined, 'local throwaway test stores only']) {
    it(`preserves a preference condition (context=${String(context)})`, () => {
      const candidate: SeedCandidate = {
        id: 'preference',
        labels: ['Preference', 'Memory'],
        content: 'does not require approval',
        currency: 'current',
        ...(context === undefined ? {} : { context }),
      };
      const pack = assemble([], { resonant: [resonantItem(candidate, 0.9)] });
      expect(pack.resonant).toHaveLength(1);
      expect(pack.resonant?.[0]?.context).toBe(context);
      if (context !== undefined) {
        expect(pack.rendered_text).toContain(context);
      }
    });
  }
});
