import { describe, expect, it } from 'vitest';

import { narrowTriggerAfter } from './cognitive-triggers.js';

describe('narrowTriggerAfter', () => {
  it('takes a full ISO timestamp as the moment the intention waits for', () => {
    expect(narrowTriggerAfter('2026-10-01T09:30:00.000Z')).toEqual(
      new Date('2026-10-01T09:30:00.000Z'),
    );
  });

  it('takes a calendar date, which is what most episodes name', () => {
    expect(narrowTriggerAfter('2026-10-01')).toEqual(new Date('2026-10-01T00:00:00.000Z'));
  });

  it('declines a condition with no date in it rather than inventing one', () => {
    expect(narrowTriggerAfter('after the reset lands')).toBeUndefined();
  });

  it('declines anything that is not a non-empty string', () => {
    expect(narrowTriggerAfter(undefined)).toBeUndefined();
    expect(narrowTriggerAfter('')).toBeUndefined();
    expect(narrowTriggerAfter('   ')).toBeUndefined();
    expect(narrowTriggerAfter(1_760_000_000_000)).toBeUndefined();
    expect(narrowTriggerAfter({ when: '2026-10-01' })).toBeUndefined();
  });
});
