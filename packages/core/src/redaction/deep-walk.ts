import { redact, redactKeyedValue, type RedactionMatch } from './redact.js';
import { isCredentialKey } from './rules.js';

export type DeepRedactionResult<T> = {
  value: T;
  matches: RedactionMatch[];
};

/**
 * Recurses through a JSON-shaped payload (objects, arrays, strings, and primitives) and
 * redacts every string, in value position and in key position alike. Keys carry secrets as
 * often as values do: a credential is a map key whenever tool output is `{ "<token>":
 * [scopes] }`, and an unredacted key reaches storage through the same episode text as any
 * leaf. Returns a new tree; the input is never mutated, so a caller holding the original
 * still has the raw content until it assigns the result. Non-plain values (Date, Map, class
 * instances) are not a payload shape this handles; both callers (the reflection tool input,
 * the recall request's query and context) pass zod-validated JSON already.
 *
 * A key from the credential vocabulary is also context for its own value: the walk carries
 * it down so `{"aws_secret_access_key": "<40 chars>"}` is judged the way the same pair
 * embedded in a string is judged, instead of the key and the value being scanned as two
 * unrelated strings that each look innocent alone. The context reaches through arrays (a
 * list of tokens under `tokens`) and stops at the next object, whose own keys replace it.
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

function redactUnderKey(
  key: string,
  value: string,
  entropyThreshold: number | undefined,
  matches: RedactionMatch[],
): string {
  const result =
    entropyThreshold === undefined
      ? redactKeyedValue(key, value)
      : redactKeyedValue(key, value, entropyThreshold);
  matches.push(...result.matches);
  return result.text;
}

function walk(
  value: unknown,
  entropyThreshold: number | undefined,
  matches: RedactionMatch[],
  credentialKey?: string,
): unknown {
  if (typeof value === 'string') {
    if (credentialKey === undefined) {
      return redactString(value, entropyThreshold, matches);
    }
    return redactUnderKey(credentialKey, value, entropyThreshold, matches);
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, entropyThreshold, matches, credentialKey));
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const context = isCredentialKey(key) ? key : undefined;
      out[redactString(key, entropyThreshold, matches)] = walk(
        entry,
        entropyThreshold,
        matches,
        context,
      );
    }
    return out;
  }

  return value;
}
