import { describe, expect, it } from 'vitest';

import { windowOn } from './excerpt-window.js';
import { buildFingerprint } from '../../redaction/fingerprint.js';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('windowOn', () => {
  it('keeps the whole paragraph around the name when it fits', () => {
    const text = 'Opening line.\n\nAion Local is the MCP service. It runs natively.\n\nClosing.';

    const window = windowOn(text, ['Aion Local'], 200);

    expect(window.text).toContain('Aion Local is the MCP service. It runs natively.');
    expect(window.placement).toEqual({ kind: 'literal', matched: 'Aion Local' });
    expect(text.slice(window.start, window.end)).toBe(window.text);
    expect(window.partUnits).toBe(text.length);
  });

  it('widens a short paragraph into its neighbours while they fit', () => {
    const text = `Before.\n\n## Aion Local\n\nIt is not the whitepaper repo.\n\n${'x'.repeat(500)}`;

    const window = windowOn(text, ['Aion Local'], 120);

    expect(window.text).toContain('## Aion Local');
    expect(window.text).toContain('It is not the whitepaper repo.');
    expect(window.text).not.toContain('xxxx');
  });

  it('keeps the negation in the sentence after the name when the paragraph is too long', () => {
    const filler = 'This sentence is only here to make the paragraph long. '.repeat(40);
    const text = `${filler}Aion Local is the MCP service. It is not the whitepaper repo. ${filler}`;

    const window = windowOn(text, ['Aion Local'], 200);

    expect(window.text).toContain('Aion Local is the MCP service.');
    expect(window.text).toContain('It is not the whitepaper repo.');
    expect(window.end - window.start).toBeLessThanOrEqual(200);
  });

  it('centres on the name when even its own sentence is too long', () => {
    const text = `${'a'.repeat(3000)} Aion Local ${'b'.repeat(3000)}`;

    const window = windowOn(text, ['Aion Local'], 400);

    expect(window.text).toContain('Aion Local');
    expect(window.end - window.start).toBeLessThanOrEqual(400);
    expect(window.start).toBeGreaterThan(0);
  });

  it('treats regex syntax in a name as literal text', () => {
    const text = 'We compared C++ (the language) with C.\n\nNothing else.';

    const window = windowOn(text, ['C++ (the language)'], 200);

    expect(window.placement).toEqual({ kind: 'literal', matched: 'C++ (the language)' });
  });

  it('places the window on the earliest name across aliases, the longest on a tie', () => {
    const text = 'aion said hello.\n\nLater, Aion Local answered.';

    expect(windowOn(text, ['Aion Local', 'aion'], 20).placement).toEqual({
      kind: 'literal',
      matched: 'aion',
    });
    expect(windowOn('Aion Local answered.', ['Aion', 'Aion Local'], 200).placement).toEqual({
      kind: 'literal',
      matched: 'Aion Local',
    });
  });

  it('matches an alias across a run of whitespace in the text', () => {
    const window = windowOn('the Aion\n   Local service', ['Aion Local'], 200);

    expect(window.placement).toEqual({ kind: 'literal', matched: 'Aion\n   Local' });
  });

  it('reports offsets into the original text where case folding changes lengths', () => {
    const text = 'İİİ hello ŁÓDŹ 😀 and more';

    const window = windowOn(text, ['łódź'], 200);

    expect(window.placement).toEqual({ kind: 'literal', matched: 'ŁÓDŹ' });
    expect(text.slice(window.start, window.end)).toBe(window.text);
    expect(window.text.indexOf('ŁÓDŹ')).toBe(text.indexOf('ŁÓDŹ') - window.start);
  });

  it('never splits a surrogate pair at either edge', () => {
    const text = `${'😀'.repeat(400)} Aion Local ${'😀'.repeat(400)}`;

    for (const width of [101, 102, 103, 250, 251]) {
      const window = windowOn(text, ['Aion Local'], width);
      expect(LONE_SURROGATE.test(window.text)).toBe(false);
      expect(window.text).toContain('Aion Local');
    }
  });

  it('never splits a redaction fingerprint at either edge', () => {
    const token = buildFingerprint('generic-secret-assignment', 'hunter2');
    const text = `${token.repeat(40)}Aion Local${token.repeat(40)}`;

    for (const width of [95, 120, 133, 200]) {
      const window = windowOn(text, ['Aion Local'], width);
      const stripped = window.text.split(token).join('');
      expect(stripped).toBe('Aion Local');
    }
  });

  it('shows the head of the part, labeled, when no name is spelled in it', () => {
    const text = 'It was renamed last week.\n\nThe old name is gone.';

    const window = windowOn(text, ['Aion Local'], 200);

    expect(window.placement).toEqual({ kind: 'no_literal_match' });
    expect(window.start).toBe(0);
    expect(window.text).toContain('It was renamed last week.');
  });
});
