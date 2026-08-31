import { describe, expect, it } from 'vitest';

import {
  buildAionHooks,
  describeAionHooks,
  mergeAionHooks,
  removeAionHooks,
  RESEARCH_MATCHER,
  SESSION_START_MATCHER,
  type HookInstallSpec,
} from './hooks-settings.js';

const SCRIPT = '/Users/someone/aion-local/packages/cli/dist/hook-main.js';

function spec(overrides: Partial<HookInstallSpec> = {}): HookInstallSpec {
  return {
    profile: 'full',
    withResearchCapture: false,
    stopMode: 'push',
    scriptPath: SCRIPT,
    ...overrides,
  };
}

const FOREIGN = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-staged' }] }],
  },
  permissions: { allow: ['Bash(npm test)'] },
};

describe('buildAionHooks', () => {
  it('covers every event on the full profile', () => {
    expect(Object.keys(buildAionHooks(spec())).sort()).toEqual([
      'PreCompact',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
  });

  it('covers only the two session boundaries on the lite profile', () => {
    expect(Object.keys(buildAionHooks(spec({ profile: 'lite' }))).sort()).toEqual([
      'SessionEnd',
      'SessionStart',
    ]);
  });

  it('matches all four session-start sources', () => {
    expect(buildAionHooks(spec()).SessionStart?.[0]?.matcher).toBe(SESSION_START_MATCHER);
    const pattern = new RegExp(`^(${SESSION_START_MATCHER})$`);
    for (const source of ['startup', 'resume', 'clear', 'compact']) {
      expect(source).toMatch(pattern);
    }
  });

  it('leaves research capture out unless it is asked for', () => {
    expect(buildAionHooks(spec()).PostToolUse).toBeUndefined();

    const withCapture = buildAionHooks(spec({ withResearchCapture: true }));
    expect(withCapture.PostToolUse?.[0]?.matcher).toBe(RESEARCH_MATCHER);
  });

  it('carries the stop mode into the command', () => {
    expect(buildAionHooks(spec({ stopMode: 'instruct' })).Stop?.[0]?.hooks[0]?.command).toBe(
      `node ${SCRIPT} stop --mode instruct`,
    );
  });

  it('runs capture-only events off the turn and injecting ones on it', () => {
    const hooks = buildAionHooks(spec({ withResearchCapture: true }));
    expect(hooks.PreCompact?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks.SubagentStop?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks.SessionStart?.[0]?.hooks[0]?.async).toBeUndefined();
    expect(hooks.Stop?.[0]?.hooks[0]?.async).toBeUndefined();
  });

  it('quotes a path that carries a space', () => {
    const quoted = buildAionHooks(spec({ scriptPath: '/Users/a b/dist/hook-main.js' }));
    expect(quoted.SessionEnd?.[0]?.hooks[0]?.command).toBe(
      'node "/Users/a b/dist/hook-main.js" session-end',
    );
  });
});

describe('mergeAionHooks', () => {
  it('writes a complete hooks block into a settings file that has none', () => {
    const merged = mergeAionHooks({}, buildAionHooks(spec()));

    expect(describeAionHooks(merged)).toHaveLength(6);
  });

  it('keeps every foreign hook and every unrelated key', () => {
    const merged = mergeAionHooks(FOREIGN, buildAionHooks(spec()));

    expect(merged.permissions).toEqual({ allow: ['Bash(npm test)'] });
    const hooks = merged.hooks as Record<string, unknown[]>;
    expect(hooks.PostToolUse).toEqual(FOREIGN.hooks.PostToolUse);
    expect(hooks.SessionStart?.[0]).toEqual(FOREIGN.hooks.SessionStart[0]);
    expect(hooks.SessionStart).toHaveLength(2);
  });

  it('replaces rather than duplicates on a second install', () => {
    const once = mergeAionHooks(FOREIGN, buildAionHooks(spec()));
    const twice = mergeAionHooks(once, buildAionHooks(spec()));

    expect(describeAionHooks(twice)).toEqual(describeAionHooks(once));
    expect((twice.hooks as Record<string, unknown[]>).SessionStart).toHaveLength(2);
  });

  it('leaves nothing from the old profile behind when the profile changes', () => {
    const full = mergeAionHooks({}, buildAionHooks(spec()));
    const lite = mergeAionHooks(full, buildAionHooks(spec({ profile: 'lite' })));

    expect(
      describeAionHooks(lite)
        .map((row) => row.event)
        .sort(),
    ).toEqual(['SessionEnd', 'SessionStart']);
    expect((lite.hooks as Record<string, unknown>).Stop).toBeUndefined();
  });

  it('passes an unrecognised event shape through untouched', () => {
    const merged = mergeAionHooks({ hooks: { Notification: 'legacy string' } }, {});

    expect((merged.hooks as Record<string, unknown>).Notification).toBe('legacy string');
  });
});

describe('removeAionHooks', () => {
  it('removes only the aion entries', () => {
    const installed = mergeAionHooks(FOREIGN, buildAionHooks(spec({ withResearchCapture: true })));

    const cleaned = removeAionHooks(installed);

    expect(describeAionHooks(cleaned)).toEqual([]);
    expect(cleaned.hooks).toEqual(FOREIGN.hooks);
    expect(cleaned.permissions).toEqual(FOREIGN.permissions);
  });

  it('drops an empty hooks block rather than leaving a husk', () => {
    const installed = mergeAionHooks({ permissions: {} }, buildAionHooks(spec()));

    expect(removeAionHooks(installed)).toEqual({ permissions: {} });
  });

  it('is a no-op on settings that were never installed into', () => {
    expect(removeAionHooks(FOREIGN)).toEqual(FOREIGN);
  });
});

describe('describeAionHooks', () => {
  it('reports the event, matcher, command, and async flag of each entry', () => {
    const installed = mergeAionHooks({}, buildAionHooks(spec({ stopMode: 'instruct' })));

    expect(describeAionHooks(installed)).toContainEqual({
      event: 'Stop',
      matcher: undefined,
      command: `node ${SCRIPT} stop --mode instruct`,
      async: false,
    });
  });
});
