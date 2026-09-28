import { AnthropicResponseError } from './anthropic-errors.js';

/**
 * Reading one JSON value out of a model's reply.
 *
 * The reply is text, whichever delivery mode asked for it, and the model sometimes wraps it in a
 * fence or answers twice. Both are cheaper to handle here than to retry.
 */

/** The model wraps JSON in a fence often enough that stripping one is cheaper than a retry. */
const FENCED_JSON = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

type JsonSpan = { readonly start: number; readonly end: number };

/**
 * Every top-level `{...}` or `[...]` run in the text, in the order they appear. The scan
 * tracks string state and escapes, so a brace inside a string value never opens or closes a
 * span, and it reports only depth-zero runs, so a nested object is part of its parent rather
 * than a candidate of its own.
 */
export function jsonSpans(text: string): readonly JsonSpan[] {
  const spans: JsonSpan[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char !== '}' && char !== ']') {
      continue;
    }
    if (depth === 0) {
      continue;
    }
    depth -= 1;
    if (depth === 0 && start >= 0) {
      spans.push({ start, end: index + 1 });
      start = -1;
    }
  }

  return spans;
}

/**
 * The whole reply when the whole reply is one JSON value, and otherwise the last complete
 * value in it.
 *
 * The model sometimes answers twice: a fenced block, a line of second thoughts about its own
 * answer, then a corrected block. Requiring the reply to be one value fails outright on that
 * shape, and taking the first value hands the caller the draft the model itself rejected, which
 * is where the invalid enum values come from. The last complete value is the one it settled on.
 */
export function parseJsonPayload(
  text: string,
  unreadable: (detail: string) => Error = (detail) => new AnthropicResponseError(detail),
): unknown {
  const trimmed = text.trim();
  const fenced = FENCED_JSON.exec(trimmed);
  try {
    return JSON.parse(fenced?.[1] ?? trimmed) as unknown;
  } catch {
    // The single-value shape is the common one; anything else goes to the scan below.
  }

  for (const span of [...jsonSpans(text)].reverse()) {
    try {
      return JSON.parse(text.slice(span.start, span.end)) as unknown;
    } catch {
      continue;
    }
  }

  throw unreadable('carried no complete JSON value');
}
