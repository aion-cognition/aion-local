import { readFileSync } from 'node:fs';

/**
 * Compose hands `.env` to the services, so nothing running on the host loads it: a key recorded
 * there is invisible to `loadConfig` and to a test run started from a shell. These readers are
 * the host-side path to a value the file already holds. They read the file on each call, which
 * suits the handful of boot-time and setup-time callers there are.
 */

/** One pair of matching quotes wraps a value. Anything else, mismatched ends included, is literal. */
function unquote(value: string): string {
  const quote = value.slice(0, 1);
  const quoted = (quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote);
  return quoted ? value.slice(1, -1) : value;
}

/** A later line for the same key wins, the way a repeated shell export would. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    if (key === '') {
      continue;
    }
    values.set(key, unquote(trimmed.slice(separator + 1).trim()));
  }
  return values;
}

function readEnvFile(path: string): Map<string, string> | undefined {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    // A missing or unreadable file is the ordinary case for a caller asking whether a value
    // was ever recorded, so it answers no rather than throwing.
    return undefined;
  }
}

export function envFileValue(path: string, key: string): string | undefined {
  return readEnvFile(path)?.get(key);
}

/**
 * Seeds the environment from the file for the named keys only. A value already there wins, so
 * an exported variable still overrides the file. `out` is the write target, and the name is
 * also what `no-param-reassign` accepts a property assignment through.
 */
export function applyEnvDefaults(
  path: string,
  keys: readonly string[],
  out: NodeJS.ProcessEnv = process.env,
): void {
  const values = readEnvFile(path);
  if (values === undefined) {
    return;
  }
  for (const key of keys) {
    if ((out[key] ?? '').trim() !== '') {
      continue;
    }
    const value = values.get(key);
    if (value === undefined || value === '') {
      continue;
    }
    out[key] = value;
  }
}
