import { describe, expect, it } from 'vitest';

import { allowedUpdatedToolInput } from './payload.js';

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
