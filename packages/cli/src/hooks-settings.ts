import type { StopMode } from './hook/options.js';

/**
 * Shaping and merging the `hooks` block of `~/.claude/settings.json`. Pure functions over
 * plain values: the command reads and writes the file, this decides what belongs in it.
 */

export type HookProfile = 'full' | 'lite';

/**
 * Which entries are ours. The path is what identifies them, so a user who renames or
 * reorders nothing keeps their own hooks through every install and uninstall.
 */
export const AION_HOOK_MARKER = 'hook-main.js';

/** The three research tools whose results are worth capturing. Nothing else fires PostToolUse. */
export const RESEARCH_MATCHER = 'mcp__slack__.*|mcp__linear-mcp-server__.*|mcp__Notion__.*';

export const SESSION_START_MATCHER = 'startup|resume|compact';

export type HookCommand = {
  readonly type: 'command';
  readonly command: string;
  readonly async?: boolean;
};

export type HookMatcher = {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
};

export type SettingsHooks = Record<string, readonly HookMatcher[]>;

export type HookInstallSpec = {
  readonly profile: HookProfile;
  readonly withResearchCapture: boolean;
  readonly stopMode: StopMode;
  /** Absolute host path to the compiled entry. Hooks run from the session's cwd, never the repo's. */
  readonly scriptPath: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function quoted(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

function command(spec: HookInstallSpec, event: string, flags: readonly string[] = []): string {
  return ['node', quoted(spec.scriptPath), event, ...flags].join(' ');
}

/** `async` keeps a capture-only hook off the turn's critical path. A hook that injects or blocks cannot use it. */
function capture(spec: HookInstallSpec, event: string, flags: readonly string[] = []): HookMatcher {
  return { hooks: [{ type: 'command', command: command(spec, event, flags), async: true }] };
}

function inline(spec: HookInstallSpec, event: string, flags: readonly string[] = []): HookMatcher {
  return { hooks: [{ type: 'command', command: command(spec, event, flags) }] };
}

function withMatcher(entry: HookMatcher, matcher: string): HookMatcher {
  return { matcher, hooks: entry.hooks };
}

export function buildAionHooks(spec: HookInstallSpec): SettingsHooks {
  const hooks: Record<string, readonly HookMatcher[]> = {
    SessionStart: [withMatcher(inline(spec, 'session-start'), SESSION_START_MATCHER)],
    SessionEnd: [inline(spec, 'session-end')],
  };

  if (spec.profile === 'full') {
    hooks.UserPromptSubmit = [inline(spec, 'prompt-submit')];
    hooks.PreCompact = [capture(spec, 'pre-compact')];
    hooks.Stop = [inline(spec, 'stop', ['--mode', spec.stopMode])];
    hooks.SubagentStop = [capture(spec, 'subagent-stop')];
  }

  if (spec.withResearchCapture) {
    hooks.PostToolUse = [withMatcher(capture(spec, 'post-tool-use'), RESEARCH_MATCHER)];
  }

  return hooks;
}

function isAionCommand(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.command === 'string' && value.command.includes(AION_HOOK_MARKER)
  );
}

/**
 * Everything that is not ours, kept verbatim. A shape this does not recognise passes through
 * untouched rather than being normalised into one it does.
 */
function stripEvent(entries: unknown): unknown {
  if (!Array.isArray(entries)) {
    return entries;
  }
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const survivors = entry.hooks.filter((hook) => !isAionCommand(hook));
    if (survivors.length === 0) {
      continue;
    }
    kept.push({ ...entry, hooks: survivors });
  }
  return kept;
}

function strippedHooks(existing: Record<string, unknown>): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(existing)) {
    const stripped = stripEvent(entries);
    if (Array.isArray(stripped) && stripped.length === 0) {
      continue;
    }
    kept[event] = stripped;
  }
  return kept;
}

/**
 * Idempotent by construction: ours come out first, then go back in, so a second install
 * replaces rather than duplicates and a profile change leaves no entry from the old one.
 */
export function mergeAionHooks(settings: unknown, aion: SettingsHooks): Record<string, unknown> {
  const base = isRecord(settings) ? { ...settings } : {};
  const merged = strippedHooks(isRecord(base.hooks) ? base.hooks : {});
  for (const [event, entries] of Object.entries(aion)) {
    const existing = merged[event];
    const kept: readonly unknown[] = Array.isArray(existing) ? (existing as unknown[]) : [];
    merged[event] = [...kept, ...entries];
  }
  base.hooks = merged;
  return base;
}

export function removeAionHooks(settings: unknown): Record<string, unknown> {
  const base = isRecord(settings) ? { ...settings } : {};
  if (!isRecord(base.hooks)) {
    return base;
  }
  const kept = strippedHooks(base.hooks);
  if (Object.keys(kept).length === 0) {
    delete base.hooks;
    return base;
  }
  base.hooks = kept;
  return base;
}

export type AionHookRow = {
  readonly event: string;
  readonly matcher: string | undefined;
  readonly command: string;
  readonly async: boolean;
};

export function describeAionHooks(settings: unknown): readonly AionHookRow[] {
  if (!isRecord(settings) || !isRecord(settings.hooks)) {
    return [];
  }
  const rows: AionHookRow[] = [];
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
        continue;
      }
      for (const hook of entry.hooks) {
        if (!isAionCommand(hook) || !isRecord(hook)) {
          continue;
        }
        rows.push({
          event,
          matcher: typeof entry.matcher === 'string' ? entry.matcher : undefined,
          command: String(hook.command),
          async: hook.async === true,
        });
      }
    }
  }
  return rows;
}
