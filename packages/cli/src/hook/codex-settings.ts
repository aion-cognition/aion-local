import {
  AION_HOOK_MARKER,
  buildAionHooks,
  type HookCommand,
  type HookInstallSpec,
  type HookMatcher,
  type SettingsHooks,
} from './settings.js';

/**
 * Shaping and merging `$CODEX_HOME/hooks.json`. Its inner `hooks` block is the shape
 * `settings.json` carries, so the readers in ./settings.js work on this document as they
 * are. What differs is the harness flag on every command, two matchers, and the rule that
 * a group may never move: codex keys trust by group and handler index.
 */

/**
 * Any tool on a research server. Codex keys a server by whatever name the user gave it,
 * so this matches the prefix and stays unanchored.
 */
export const CODEX_RESEARCH_MATCHER = 'mcp__(slack|linear|notion|Notion)';

/** Codex clamps SessionEnd to 3 seconds and defaults it to 1, which node startup alone can eat. */
const SESSION_END_TIMEOUT_SECONDS = 3;

/** Codex reads seconds from `timeout`. The rest of the handler is what claude takes. */
type CodexHookCommand = HookCommand & { readonly timeout?: number };

type CodexHookMatcher = {
  readonly matcher?: string;
  readonly hooks: readonly CodexHookCommand[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function codexHandler(event: string, hook: HookCommand): CodexHookCommand {
  const command = `${hook.command} --harness codex`;
  if (event === 'SessionEnd') {
    return { ...hook, command, timeout: SESSION_END_TIMEOUT_SECONDS };
  }
  return { ...hook, command };
}

function codexMatcher(event: string, matcher: string | undefined): string | undefined {
  // All four start sources are wanted, and a missing matcher is one less thing to re-trust.
  if (event === 'SessionStart') {
    return undefined;
  }
  if (event === 'PostToolUse') {
    return CODEX_RESEARCH_MATCHER;
  }
  return matcher;
}

function codexEntry(event: string, entry: HookMatcher): CodexHookMatcher {
  const hooks = entry.hooks.map((hook) => codexHandler(event, hook));
  const matcher = codexMatcher(event, entry.matcher);
  if (matcher === undefined) {
    return { hooks };
  }
  return { matcher, hooks };
}

/** The events claude gets, with the deltas codex needs. The flag tells the hook which one fired. */
export function buildCodexAionHooks(spec: HookInstallSpec): SettingsHooks {
  const hooks: Record<string, readonly CodexHookMatcher[]> = {};
  for (const [event, entries] of Object.entries(buildAionHooks(spec))) {
    hooks[event] = entries.map((entry) => codexEntry(event, entry));
  }
  return hooks;
}

function isAionCommand(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.command === 'string' && value.command.includes(AION_HOOK_MARKER)
  );
}

function isAionGroup(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.hooks) && value.hooks.some(isAionCommand);
}

/**
 * Ours lands on the index the last install left it on, and a group that is not ours keeps
 * both its index and its content. Codex trust keys embed the group and handler index, so
 * inserting ahead of someone's own entry would ask them to trust it again.
 */
function mergedEvent(entries: unknown, aion: readonly HookMatcher[] | undefined): unknown {
  if (!Array.isArray(entries)) {
    // A shape this does not recognise passes through rather than being normalised into one it does.
    return aion === undefined ? entries : [...aion];
  }
  const kept: unknown[] = [];
  let placed = false;
  for (const entry of entries) {
    if (!isAionGroup(entry)) {
      kept.push(entry);
      continue;
    }
    if (aion !== undefined && !placed) {
      kept.push(...aion);
      placed = true;
    }
  }
  if (aion !== undefined && !placed) {
    kept.push(...aion);
  }
  return kept;
}

/**
 * Idempotent by construction: a second merge of the same spec finds each group where it
 * put it and writes the same value back, and an event the spec dropped loses its group.
 */
export function mergeCodexAionHooks(file: unknown, aion: SettingsHooks): Record<string, unknown> {
  const base = isRecord(file) ? { ...file } : {};
  const existing = isRecord(base.hooks) ? base.hooks : {};
  const merged: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(existing)) {
    const rebuilt = mergedEvent(entries, aion[event]);
    if (Array.isArray(rebuilt) && rebuilt.length === 0) {
      continue;
    }
    merged[event] = rebuilt;
  }
  for (const [event, entries] of Object.entries(aion)) {
    if (merged[event] === undefined) {
      merged[event] = [...entries];
    }
  }
  base.hooks = merged;
  return base;
}
