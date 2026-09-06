import { describe, expect, it } from 'vitest';

import { generationSkipReason, HOOK_ORIGIN_CHANNEL, SUBAGENT_STOP_EVENT } from './capture-class.js';
import type { EpisodeContext } from '../../infrastructure/graph/episode-context.js';

const FLOOR = 64;

const PROGRESS_LINE = 'observation: [Explore] wrote the plan file';

const SYNTHESIS =
  'observation: [Explore] the seed budget is computed before the legs run, because a leg ' +
  'that fetches fewer rows than its reservation cannot fill it, and the recency leg reads ' +
  'the whole budget as one query.';

function episode(overrides: Partial<EpisodeContext> = {}): EpisodeContext {
  return {
    id: 'episode-1',
    sessionId: 'session-1',
    text: PROGRESS_LINE,
    turns: [],
    originChannel: HOOK_ORIGIN_CHANNEL,
    originEvent: SUBAGENT_STOP_EVENT,
    ...overrides,
  };
}

describe('generationSkipReason', () => {
  it('declines a sub-floor capture of the class and says what it declined and why', () => {
    const reason = generationSkipReason(episode(), FLOOR);
    expect(reason).toContain(SUBAGENT_STOP_EVENT);
    expect(reason).toContain('64 byte extraction floor');
    expect(reason).toContain('the episode and its embedding stand');
  });

  it('reads a synthesis from the same hook, because the class alone decides nothing', () => {
    expect(generationSkipReason(episode({ text: SYNTHESIS }), FLOOR)).toBeUndefined();
  });

  it('reads a short capture from every other path, because the floor bounds one class', () => {
    expect(generationSkipReason(episode({ originEvent: 'stop' }), FLOOR)).toBeUndefined();
    expect(generationSkipReason(episode({ originChannel: 'mcp' }), FLOOR)).toBeUndefined();
    expect(
      generationSkipReason(
        { ...episode(), originChannel: undefined, originEvent: undefined },
        FLOOR,
      ),
    ).toBeUndefined();
  });

  it('measures bytes rather than characters, so wide text counts what it costs', () => {
    const wide = 'こんにちは'.repeat(5);
    expect(wide.length).toBeLessThan(FLOOR);
    expect(generationSkipReason(episode({ text: wide }), FLOOR)).toBeUndefined();
  });

  it('reads a capture exactly at the floor', () => {
    expect(generationSkipReason(episode({ text: 'a'.repeat(FLOOR) }), FLOOR)).toBeUndefined();
    expect(generationSkipReason(episode({ text: 'a'.repeat(FLOOR - 1) }), FLOOR)).toBeDefined();
  });
});
