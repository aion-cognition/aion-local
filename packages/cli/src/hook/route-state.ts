import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which generation route a hook fire would be feeding, answered from the two places a fire can
 * see: its own environment and the repo `.env` the compiled entry sits in.
 *
 * It used to answer a different question — whether an Anthropic key existed — and a fire that
 * found none removed the hooks from the settings file. That rule came from a build where the
 * local model could not keep up with a capture on every turn. It cannot survive its own premise:
 * the substrate is local-first, the key is optional spend, and local reflection measured 18.5s a
 * call. Hooks are route-agnostic now.
 *
 * There is no configuration in which no route exists, and that is the routing rule rather than an
 * assumption made here: a role pinned to Anthropic with no key resolves to the local model, which
 * `aion status` and `aion doctor` both report. So this answers which route a fire feeds and never
 * refuses on it. What a fire still fails open on is the service not answering, which is a fact
 * about a running process rather than about configuration.
 *
 * `unknown` stays a real answer: a `.env` this cannot read says nothing, and the local route is
 * the safe reading of nothing.
 */

const ANTHROPIC_KEY_ENV_VAR = 'AION_ANTHROPIC_API_KEY';

const ENV_FILE_NAME = '.env';

/** `<repo>/packages/cli/dist/hook-main.js` is where the harness invokes this from. */
const SCRIPT_DEPTH = 4;

/** `keyed` routes generation to Anthropic per the routing knobs; `local` is the Ollama route. */
export type GenerationRoute = 'keyed' | 'local' | 'unknown';

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

export function generationRoute(
  env: NodeJS.ProcessEnv,
  scriptPath: string | undefined,
): GenerationRoute {
  if ((env[ANTHROPIC_KEY_ENV_VAR] ?? '').trim() !== '') {
    return 'keyed';
  }
  if (scriptPath === undefined || scriptPath === '') {
    return 'unknown';
  }
  const recorded = envFileValue(join(repoRootOf(scriptPath), ENV_FILE_NAME), ANTHROPIC_KEY_ENV_VAR);
  if (recorded === undefined) {
    return 'unknown';
  }
  return recorded.trim() === '' ? 'local' : 'keyed';
}
