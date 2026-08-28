import { redact, type RedactionMatch } from './redact.js';

export type DeepRedactionResult<T> = {
  value: T;
  matches: RedactionMatch[];
};

/**
 * Recurses through a JSON-shaped payload (the reflection tool input: objects, arrays,
 * strings, and primitives) and redacts every string, in value position and in key
 * position alike. Keys carry secrets as often as values do — a credential is a map key
 * whenever tool output is `{ "<token>": [scopes] }` — and an unredacted key reaches
 * storage through the same episode text as any leaf. Returns a new tree; the input is
 * never mutated, so a caller holding the original still has the raw content until it
 * assigns the result. Non-plain values (Date, Map, class instances) are not a payload
 * shape this handles; the reflection input is zod-validated JSON already.
 */
export function redactPayload<T>(value: T, entropyThreshold?: number): DeepRedactionResult<T> {
  const matches: RedactionMatch[] = [];
  const redactedValue = walk(value, entropyThreshold, matches) as T;
  return { value: redactedValue, matches };
}

function redactString(
  value: string,
  entropyThreshold: number | undefined,
  matches: RedactionMatch[],
): string {
  const result = entropyThreshold === undefined ? redact(value) : redact(value, entropyThreshold);
  matches.push(...result.matches);
  return result.text;
}

function walk(value: unknown, entropyThreshold: number | undefined, matches: RedactionMatch[]): unknown {
  if (typeof value === 'string') {
    return redactString(value, entropyThreshold, matches);
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, entropyThreshold, matches));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[redactString(key, entropyThreshold, matches)] = walk(entry, entropyThreshold, matches);
    }
    return out;
  }

  return value;
}
