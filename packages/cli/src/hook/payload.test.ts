import { describe, expect, it } from 'vitest';

import { allowedUpdatedToolInput, recallArgs } from './payload.js';

describe('allowedUpdatedToolInput', () => {
  it('pairs the rewritten arguments with an allow decision and adds nothing else', () => {
    const frame: unknown = JSON.parse(
      allowedUpdatedToolInput('PreToolUse', { a: 1, session_id: 's' }),
    );

    expect(frame).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { a: 1, session_id: 's' },
      },
    });
  });
});

describe('recallArgs', () => {
  it('omits the reset flag by default', () => {
    expect(recallArgs('q', 1200, 'session-1')).toEqual({
      query: 'q',
      budget: { max_tokens: 1200 },
      session_id: 'session-1',
    });
  });

  it('carries the reset flag only when the caller asks for it', () => {
    expect(recallArgs('q', 1200, 'session-1', true)).toEqual({
      query: 'q',
      budget: { max_tokens: 1200 },
      session_id: 'session-1',
      reset_delivery_suppression: true,
    });
  });
});
