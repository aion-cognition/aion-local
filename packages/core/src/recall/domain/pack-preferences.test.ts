import { describe, expect, it } from 'vitest';

import { assemble, item } from './test-support/pack.fixture.js';

/**
 * How an inferred preference reaches the agent: in its own bucket, under its own standing, and
 * never as a sentence the member said. The bucket supplies the noun and the standing supplies
 * the inference, so the two together say what the item is without either restating the other.
 */
describe('the preferences bucket', () => {
  const preference = item('pref-1', {
    labels: ['Preference', 'Memory', 'AionNode'],
    content: 'asks for a dry run before any destructive command',
  });

  it('routes a Preference to the bucket named after it', () => {
    const pack = assemble([preference]);

    expect(pack.preferences?.map((entry) => entry.id)).toEqual(['pref-1']);
    expect(pack.facts ?? []).toEqual([]);
    expect(pack.rendered_text).toContain('## Preferences');
  });

  it('serves it as an inference nobody is on record as having said', () => {
    const pack = assemble([preference]);
    const served = pack.preferences?.[0];

    expect(served?.standing).toEqual(
      expect.objectContaining({ kind: 'inferred_preference', attribution: 'unknown' }),
    );
    expect(served?.standing?.confirmed).toBeUndefined();
    expect(pack.rendered_text).toContain('inferred');
  });

  it('separates it from a claim the extraction read out of one capture', () => {
    const pack = assemble([
      preference,
      item('insight-1', { labels: ['Insight', 'Memory', 'AionNode'] }),
    ]);

    expect(pack.preferences?.[0]?.standing?.kind).toBe('inferred_preference');
    expect(pack.facts?.[0]?.standing?.kind).toBe('extracted_interpretation');
  });
});
