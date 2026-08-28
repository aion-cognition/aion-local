import { redact, type RedactionMatch } from './redact.js';

export type DeepRedactionResult<T> = {
  value: T;
  matches: RedactionMatch[];
};

/**
 * Recurses through a JSON-shaped payload (the reflection tool input: objects, arrays,
 * strings, and primitives) and redacts every string leaf. Returns a new tree — the
 * input is never mutated, so a caller holding the original still has the raw content
 * until it assigns the result. Non-plain values (Date, Map, class instances) are not
 * a payload shape this handles; the reflection input is zod-validated JSON already.
 */
export function redactPayload<T>(value: T, entropyThreshold?: number): DeepRedactionResult<T> {
  const matches: RedactionMatch[] = [];
  const redactedValue = walk(value, entropyThreshold, matches) as T;
  return { value: redactedValue, matches };
}

function walk(value: unknown, entropyThreshold: number | undefined, matches: RedactionMatch[]): unknown {
  if (typeof value === 'string') {
    const result = entropyThreshold === undefined ? redact(value) : redact(value, entropyThreshold);
    matches.push(...result.matches);
    return result.text;
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, entropyThreshold, matches));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = walk(entry, entropyThreshold, matches);
    }
    return out;
  }

  return value;
}
