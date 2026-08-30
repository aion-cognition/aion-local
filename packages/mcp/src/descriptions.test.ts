import { describe, expect, it } from 'vitest';

import {
  DESCRIPTIONS_VERSION,
  RECALL_DESCRIPTION,
  REFLECTION_DESCRIPTION,
  USAGE_PROTOCOL,
} from './descriptions.js';

/**
 * The descriptions are the cadence mechanism, so the invocation moments they pin are
 * asserted rather than left to a future edit's judgment. A rewrite that drops one fails
 * here, which is the point: the text is product surface, not documentation.
 */

describe('recall description', () => {
  it('names when to call it, not only what it does', () => {
    expect(RECALL_DESCRIPTION).toContain('at the start of a session');
    expect(RECALL_DESCRIPTION).toContain('before starting work on a topic');
    expect(RECALL_DESCRIPTION).toContain('new topic');
  });

  it('tells the agent an empty answer is an answer', () => {
    expect(RECALL_DESCRIPTION).toContain('An empty pack is a real answer');
  });

  it('surfaces the two time-travel inputs, which nothing else would explain', () => {
    expect(RECALL_DESCRIPTION).toContain('`as_of`');
    expect(RECALL_DESCRIPTION).toContain('`knew_at`');
  });
});

describe('reflection description', () => {
  it('names the three moments the description pins', () => {
    expect(REFLECTION_DESCRIPTION).toContain('after completing meaningful work');
    expect(REFLECTION_DESCRIPTION).toContain('before a context switch');
    expect(REFLECTION_DESCRIPTION).toContain('at the end of a session');
  });

  it('says intake is fast so the agent does not batch calls to protect its latency', () => {
    expect(REFLECTION_DESCRIPTION).toContain('Intake returns as soon as the experience is durable');
  });
});

describe('usage protocol', () => {
  it('carries the same cadence rule the CLAUDE.md snippet ships', () => {
    expect(USAGE_PROTOCOL).toContain('Recall at the start of a session');
    expect(USAGE_PROTOCOL).toContain('reflection after meaningful work');
  });
});

describe('version', () => {
  it('is an integer the tool definitions can publish', () => {
    expect(Number.isInteger(DESCRIPTIONS_VERSION)).toBe(true);
    expect(DESCRIPTIONS_VERSION).toBeGreaterThan(0);
  });
});
