import type { ReflectionTurn } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import { applyBirthFence } from './birth-fence.js';
import type { ReflectionContent } from './content.js';

const BIRTH = new Date('2026-09-14T10:07:37.000Z');

function turn(text: string, occurredAt: string | undefined): ReflectionTurn {
  return { role: 'user', text, occurred_at: occurredAt };
}

describe('applyBirthFence', () => {
  it('passes everything through unchanged when the substrate birth is unknown', () => {
    const content: ReflectionContent = {
      turns: [turn('from before anyone can say', '2020-01-01T00:00:00Z')],
    };

    const outcome = applyBirthFence(content, undefined);

    expect(outcome).toEqual({ content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false });
  });

  it('accepts every turn stamped after birth, untrimmed', () => {
    const content: ReflectionContent = {
      turns: [
        turn('right after init', '2026-09-14T10:09:12Z'),
        turn('a little later', '2026-09-14T10:09:56Z'),
      ],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome).toEqual({ content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false });
  });

  it('refuses a push where every turn predates birth, as a disclosed no-op', () => {
    const content: ReflectionContent = {
      turns: [
        turn('cleanup instructions from before init', '2026-09-14T10:03:40Z'),
        turn('a build-guard reply from earlier still', '2026-09-14T10:02:10Z'),
      ],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome.emptied).toBe(true);
    expect(outcome.trimmedTurns).toBe(2);
    expect(outcome.content.turns).toEqual([]);
  });

  it('trims only the pre-birth turns out of a mixed push, keeping the rest in order', () => {
    const content: ReflectionContent = {
      turns: [
        turn('before init', '2026-09-14T10:02:10Z'),
        turn('after init', '2026-09-14T10:09:12Z'),
        turn('also after init', '2026-09-14T10:10:00Z'),
      ],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome.emptied).toBe(false);
    expect(outcome.trimmedTurns).toBe(1);
    expect(outcome.content.turns?.map((t) => t.text)).toEqual(['after init', 'also after init']);
  });

  it('accepts a turn stamped at exactly the instant of birth', () => {
    const content: ReflectionContent = {
      turns: [turn('the first thing said', BIRTH.toISOString())],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome).toEqual({ content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false });
  });

  it('refuses a turn stamped one millisecond before birth', () => {
    const content: ReflectionContent = {
      turns: [turn('one millisecond too early', new Date(BIRTH.getTime() - 1).toISOString())],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome.emptied).toBe(true);
    expect(outcome.trimmedTurns).toBe(1);
  });

  // The axis is when the line was spoken, never what it describes. A post-birth turn is
  // ordinary conversation whatever date its own text names, and nothing here may parse one out
  // of `text` to decide otherwise.
  it('keeps a post-birth turn untrimmed even when its own text names a date before birth', () => {
    const content: ReflectionContent = {
      turns: [turn('remember when we shipped this back in July 2020?', '2026-09-14T10:09:12Z')],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome).toEqual({ content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false });
  });

  it('passes a turn through unfiltered when it carries no timestamp of its own', () => {
    const content: ReflectionContent = { turns: [turn('no timestamp at all', undefined)] };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome).toEqual({ content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false });
  });

  it('trims tool executions on the same axis as turns', () => {
    const content: ReflectionContent = {
      tool_executions: [
        { tool: 'bash', status: 'ok', occurred_at: '2026-09-14T10:02:00Z' },
        { tool: 'bash', status: 'ok', occurred_at: '2026-09-14T10:09:00Z' },
      ],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome.emptied).toBe(false);
    expect(outcome.trimmedToolExecutions).toBe(1);
    expect(outcome.content.tool_executions).toHaveLength(1);
  });

  it('is not emptied when observations survive a push whose turns are entirely pre-birth', () => {
    const content: ReflectionContent = {
      turns: [turn('before init', '2026-09-14T10:02:10Z')],
      observations: ['a decision that stands on its own'],
    };

    const outcome = applyBirthFence(content, BIRTH);

    expect(outcome.emptied).toBe(false);
    expect(outcome.trimmedTurns).toBe(1);
    expect(outcome.content.observations).toEqual(['a decision that stands on its own']);
  });
});
