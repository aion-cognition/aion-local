import { describe, expect, it } from 'vitest';

import { MIN_CACHEABLE_PREFIX_CHARS } from './anthropic-cache.js';
import {
  composeSystemBlocks,
  sharedPrefixBytes,
  taskBlockOf,
  type SystemBlock,
} from './request-blocks.js';
import { FRAME_VERSION, frameFor, frameText } from '../../prompts/frame.js';

/**
 * What the composition promises, proved on the outgoing request rather than on a live call.
 *
 * Four claims: the task text reaches the model unchanged, exactly one frame is sent, the cache
 * breakpoint sits at the end of the frame and nowhere else, and the bytes ahead of that
 * breakpoint are identical across surfaces.
 */

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' } } };

function blocksFor(surface: string, instructions: string): readonly SystemBlock[] {
  return composeSystemBlocks({
    surface,
    instructions,
    schema: SCHEMA,
    promptCache: true,
  });
}

describe('the shared two-block composition', () => {
  it('sends the frame first and the task second, and nothing else', () => {
    const blocks = blocksFor('cues', 'You extract cues.');

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe(frameText('concise'));
    expect(blocks[1]?.text).toContain('You extract cues.');
  });

  it('leaves the task text exactly as its surface wrote it', () => {
    const instructions = 'You extract cues.\n\nSecond paragraph, with  odd   spacing.';
    const blocks = blocksFor('cues', instructions);

    expect(blocks[1]?.text.startsWith(instructions)).toBe(true);
    expect(blocks[1]?.text).toBe(taskBlockOf(instructions, SCHEMA));
  });

  it('carries one frame however many system messages the surface wrote', () => {
    const blocks = composeSystemBlocks({
      surface: 'synthesis',
      instructions: 'first\n\nsecond',
      schema: SCHEMA,
      promptCache: true,
    });

    expect(blocks.filter((block) => block.text === frameText('full'))).toHaveLength(1);
  });

  it('puts the same bytes ahead of the breakpoint on every surface', () => {
    const extraction = blocksFor('cognitive', 'Extract the nine types.');
    const judgment = blocksFor('supersession_judge', 'Judge the pair.');

    expect(sharedPrefixBytes(extraction)).toBe(frameText('concise').length);
    expect(sharedPrefixBytes(judgment)).toBe(frameText('full').length);
    expect(blocksFor('cues', 'a')[0]?.text).toBe(blocksFor('cognitive', 'b')[0]?.text);
  });

  it('marks the frame for the hour, and marks nothing else, once it clears the floor', () => {
    const long = 'x'.repeat(MIN_CACHEABLE_PREFIX_CHARS);
    const blocks = composeSystemBlocks({
      surface: 'cues',
      instructions: 'You extract cues.',
      schema: SCHEMA,
      promptCache: true,
      frameOverride: { text: long },
    });

    expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks[1]?.cache_control).toBeUndefined();
  });

  it('leaves the marker off a frame the model would not cache anyway', () => {
    const blocks = blocksFor('cues', 'You extract cues.');

    expect(frameText('concise').length).toBeLessThan(MIN_CACHEABLE_PREFIX_CHARS);
    expect(blocks[0]?.cache_control).toBeUndefined();
  });

  it('sends no frame at all when the harness asks for the comparison without one', () => {
    const blocks = composeSystemBlocks({
      surface: 'cues',
      instructions: 'You extract cues.',
      schema: SCHEMA,
      promptCache: true,
      frameOverride: { none: true },
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(taskBlockOf('You extract cues.', SCHEMA));
  });

  it('reads a surface the allocation does not name as concise', () => {
    expect(frameFor('a-surface-nobody-allocated')).toBe('concise');
    expect(frameFor(undefined)).toBe('concise');
  });

  it('carries a version, so outstanding work can be settled under the frame it was built with', () => {
    expect(FRAME_VERSION).toMatch(/^frame-\d+$/);
  });
});
