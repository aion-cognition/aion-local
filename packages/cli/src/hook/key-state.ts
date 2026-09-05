import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Whether this machine holds an Anthropic key, answered from the two places a hook fire can
 * see: its own environment and the repo `.env` the compiled entry sits in. Hooks capture raw
 * transcript windows, which only the keyed profile digests, so the answer decides whether a
 * fire captures at all.
 *
 * `unknown` is a real answer and not a failure: a file this cannot read says nothing about the
 * key, and a hook that guesses wrong there would delete a working install.
 */

const ANTHROPIC_KEY_ENV_VAR = 'AION_ANTHROPIC_API_KEY';

const ENV_FILE_NAME = '.env';

/** `<repo>/packages/cli/dist/hook-main.js` is where the harness invokes this from. */
const SCRIPT_DEPTH = 4;

export type KeyState = 'present' | 'absent' | 'unknown';

/** One pair of matching quotes wraps a value. Anything else, mismatched ends included, is literal. */
function unquote(value: string): string {
  const quote = value.slice(0, 1);
  const quoted = (quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote);
  return quoted ? value.slice(1, -1) : value;
}

/**
 * The core package parses `.env` the same way, and this is a deliberate copy of it: the hook
 * subtree imports node builtins and its own siblings only, so that it loads on a host that
 * never ran `npm install`. The isolation rule outranks the duplication. A later line for the
 * same key wins, the way a repeated shell export would.
 */
function envFileValue(path: string, key: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  let found = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1 || trimmed.slice(0, separator).trim() !== key) {
      continue;
    }
    found = unquote(trimmed.slice(separator + 1).trim());
  }
  return found;
}

function repoRootOf(scriptPath: string): string {
  let root = scriptPath;
  for (let step = 0; step < SCRIPT_DEPTH; step += 1) {
    root = dirname(root);
  }
  return root;
}

export function anthropicKeyState(
  env: NodeJS.ProcessEnv,
  scriptPath: string | undefined,
): KeyState {
  if ((env[ANTHROPIC_KEY_ENV_VAR] ?? '').trim() !== '') {
    return 'present';
  }
  if (scriptPath === undefined || scriptPath === '') {
    return 'unknown';
  }
  const recorded = envFileValue(join(repoRootOf(scriptPath), ENV_FILE_NAME), ANTHROPIC_KEY_ENV_VAR);
  if (recorded === undefined) {
    return 'unknown';
  }
  return recorded.trim() === '' ? 'absent' : 'present';
}
