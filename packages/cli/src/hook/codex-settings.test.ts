import { describe, expect, it } from 'vitest';

import {
  buildCodexAionHooks,
  CODEX_RESEARCH_MATCHER,
  mergeCodexAionHooks,
} from './codex-settings.js';
import {
  AION_TOOL_MATCHER,
  describeAionHooks,
  removeAionHooks,
  type HookInstallSpec,
  type SettingsHooks,
} from './settings.js';

const SCRIPT = '/Users/someone/aion-local/packages/cli/dist/hook-main.js';

function spec(overrides: Partial<HookInstallSpec> = {}): HookInstallSpec {
  return {
    profile: 'full',
    withResearchCapture: true,
    stopMode: 'push',
    scriptPath: SCRIPT,
    ...overrides,
  };
}

function commandsIn(hooks: SettingsHooks): readonly string[] {
  return Object.values(hooks).flatMap((entries) =>
    entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)),
  );
}

const USER_PRE_TOOL_USE = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'echo mine', timeout: 10 }],
};

const USER_PROMPT_SUBMIT = { hooks: [{ type: 'command', command: 'echo prompt' }] };

function groupsFor(file: Record<string, unknown>, event: string): readonly unknown[] {
  const hooks = file.hooks as Record<string, unknown>;
  return hooks[event] as readonly unknown[];
}

describe('buildCodexAionHooks', () => {
  it('covers every event on the full profile with research capture', () => {
    expect(Object.keys(buildCodexAionHooks(spec())).sort()).toEqual([
      'PostToolUse',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
  });

  it('covers the two session boundaries and the session stamp on the lite profile', () => {
    const lite = buildCodexAionHooks(spec({ profile: 'lite', withResearchCapture: false }));

    expect(Object.keys(lite).sort()).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart']);
  });

  it('names the harness on every command it installs', () => {
    const commands = commandsIn(buildCodexAionHooks(spec()));

    expect(commands).toHaveLength(8);
    expect(commands.filter((command) => !command.endsWith(' --harness codex'))).toEqual([]);
  });

  it('puts the harness after the event and its flags', () => {
    const hooks = buildCodexAionHooks(spec({ stopMode: 'instruct' }));

    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe(
      `node ${SCRIPT} stop --mode instruct --harness codex`,
    );
  });

  it('gives session end the longest timeout codex allows', () => {
    expect(buildCodexAionHooks(spec()).SessionEnd?.[0]?.hooks[0]).toEqual({
      type: 'command',
      command: `node ${SCRIPT} session-end --harness codex`,
      timeout: 3,
    });
  });

  it('leaves session start unmatched so every start source fires', () => {
    const entry = buildCodexAionHooks(spec()).SessionStart?.[0];

    expect(entry).not.toHaveProperty('matcher');
    expect(entry?.hooks[0]?.command).toBe(`node ${SCRIPT} session-start --harness codex`);
  });

  it('captures results from the three research servers and nothing else', () => {
    expect(buildCodexAionHooks(spec()).PostToolUse?.[0]?.matcher).toBe(CODEX_RESEARCH_MATCHER);

    const pattern = new RegExp(CODEX_RESEARCH_MATCHER);
    for (const tool of [
      'mcp__slack__conversations_history',
      'mcp__linear-mcp-server__list_issues',
      'mcp__Notion__notion-search',
      'mcp__notion__search',
    ]) {
      expect(tool).toMatch(pattern);
    }
    for (const tool of ['mcp__aion__recall', 'Bash', 'mcp__postgres__execute_sql']) {
      expect(tool).not.toMatch(pattern);
    }
  });

  it('stamps both aion tools', () => {
    expect(buildCodexAionHooks(spec()).PreToolUse?.[0]?.matcher).toBe(AION_TOOL_MATCHER);
  });

  it('runs capture-only events off the turn and the rest on it', () => {
    const hooks = buildCodexAionHooks(spec());

    expect(hooks.PreCompact?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks.SubagentStop?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.async).toBe(true);
    expect(hooks.SessionStart?.[0]?.hooks[0]?.async).toBeUndefined();
    expect(hooks.SessionEnd?.[0]?.hooks[0]?.async).toBeUndefined();
    expect(hooks.Stop?.[0]?.hooks[0]?.async).toBeUndefined();
  });
});

describe('mergeCodexAionHooks', () => {
  it('writes a hooks block into a file that has none', () => {
    const merged = mergeCodexAionHooks({}, buildCodexAionHooks(spec()));

    expect(Object.keys(merged)).toEqual(['hooks']);
    expect(describeAionHooks(merged)).toHaveLength(8);
  });

  it('replaces an installed group where it already sits', () => {
    const installed = mergeCodexAionHooks({}, buildCodexAionHooks(spec()));
    const file = {
      hooks: {
        ...(installed.hooks as Record<string, unknown>),
        PreToolUse: [USER_PRE_TOOL_USE, ...groupsFor(installed, 'PreToolUse')],
      },
    };
    const before = JSON.stringify(USER_PRE_TOOL_USE);

    const merged = mergeCodexAionHooks(file, buildCodexAionHooks(spec({ stopMode: 'instruct' })));

    const groups = groupsFor(merged, 'PreToolUse');
    expect(groups).toHaveLength(2);
    expect(JSON.stringify(groups[0])).toBe(before);
    expect(groups[1]).toEqual({
      matcher: AION_TOOL_MATCHER,
      hooks: [{ type: 'command', command: `node ${SCRIPT} pre-tool-use --harness codex` }],
    });
  });

  it('leaves a group that was installed ahead of a user group where it is', () => {
    const installed = mergeCodexAionHooks({}, buildCodexAionHooks(spec()));
    const file = {
      hooks: {
        ...(installed.hooks as Record<string, unknown>),
        PreToolUse: [...groupsFor(installed, 'PreToolUse'), USER_PRE_TOOL_USE],
      },
    };

    const merged = mergeCodexAionHooks(file, buildCodexAionHooks(spec({ stopMode: 'instruct' })));

    const groups = groupsFor(merged, 'PreToolUse');
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({
      matcher: AION_TOOL_MATCHER,
      hooks: [{ type: 'command', command: `node ${SCRIPT} pre-tool-use --harness codex` }],
    });
    expect(groups[1]).toEqual(USER_PRE_TOOL_USE);
  });

  it('appends after the groups a user already has for an event', () => {
    const merged = mergeCodexAionHooks(
      { hooks: { UserPromptSubmit: [USER_PROMPT_SUBMIT] } },
      buildCodexAionHooks(spec()),
    );

    const groups = groupsFor(merged, 'UserPromptSubmit');
    expect(groups[0]).toEqual(USER_PROMPT_SUBMIT);
    expect(groups).toHaveLength(2);
  });

  it('drops an event the new profile no longer installs', () => {
    const full = mergeCodexAionHooks(
      { hooks: { UserPromptSubmit: [USER_PROMPT_SUBMIT] } },
      buildCodexAionHooks(spec()),
    );

    const lite = mergeCodexAionHooks(
      full,
      buildCodexAionHooks(spec({ profile: 'lite', withResearchCapture: false })),
    );

    expect(groupsFor(lite, 'UserPromptSubmit')).toEqual([USER_PROMPT_SUBMIT]);
    expect((lite.hooks as Record<string, unknown>).Stop).toBeUndefined();
    expect(
      describeAionHooks(lite)
        .map((row) => row.event)
        .sort(),
    ).toEqual(['PreToolUse', 'SessionEnd', 'SessionStart']);
  });

  it('keeps the description the file came with', () => {
    const merged = mergeCodexAionHooks(
      { description: 'my hooks', hooks: {} },
      buildCodexAionHooks(spec()),
    );

    expect(merged.description).toBe('my hooks');
  });

  it('changes nothing on a second install of the same spec', () => {
    const once = mergeCodexAionHooks(
      { description: 'my hooks', hooks: { PreToolUse: [USER_PRE_TOOL_USE] } },
      buildCodexAionHooks(spec()),
    );

    const twice = mergeCodexAionHooks(once, buildCodexAionHooks(spec()));

    expect(twice).toEqual(once);
  });

  it('passes an unrecognised event shape through untouched', () => {
    const merged = mergeCodexAionHooks({ hooks: { Interrupt: 'legacy string' } }, {});

    expect((merged.hooks as Record<string, unknown>).Interrupt).toBe('legacy string');
  });
});

describe('the claude readers on a codex hooks file', () => {
  it('report and strip the same entries they do in settings.json', () => {
    const installed = mergeCodexAionHooks(
      { description: 'my hooks', hooks: { PreToolUse: [USER_PRE_TOOL_USE] } },
      buildCodexAionHooks(spec()),
    );

    expect(describeAionHooks(installed)).toContainEqual({
      event: 'PostToolUse',
      matcher: CODEX_RESEARCH_MATCHER,
      command: `node ${SCRIPT} post-tool-use --harness codex`,
      async: true,
    });

    const cleaned = removeAionHooks(installed);
    expect(describeAionHooks(cleaned)).toEqual([]);
    expect(cleaned).toEqual({
      description: 'my hooks',
      hooks: { PreToolUse: [USER_PRE_TOOL_USE] },
    });
  });
});
