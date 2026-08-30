import { findHighEntropyTokens, type TextSpan } from './entropy.js';
import { buildFingerprint } from './fingerprint.js';
import {
  HIGH_ENTROPY_RULE_ID,
  isCredentialValue,
  REDACTION_RULES,
  type RedactionRule,
} from './rules.js';

/**
 * Mirrors `DEFAULTS.redaction.entropyThreshold` in `config/defaults.ts`. Duplicated
 * rather than imported: this module stays a standalone, config-free pure function,
 * and callers that hold a loaded `Config` pass its value in explicitly instead.
 */
export const DEFAULT_ENTROPY_THRESHOLD = 4.5;

/** The rule a structured credential field falls back to, and the one the embedded form shares. */
const GENERIC_SECRET_RULE_ID = 'generic-secret-assignment';

export type RedactionMatch = {
  rule: string;
  fingerprint: string;
};

export type RedactionResult = {
  text: string;
  matches: RedactionMatch[];
};

type RuleOccurrence = {
  start: number;
  end: number;
  material: string;
};

type FoundOccurrence = RuleOccurrence & { ruleId: string };

function withIndices(pattern: RegExp): RegExp {
  const flags = new Set(pattern.flags);
  flags.add('g');
  flags.add('d');
  return new RegExp(pattern.source, Array.from(flags).join(''));
}

function occurrencesForRule(rule: RedactionRule, text: string): RuleOccurrence[] {
  const regex = withIndices(rule.pattern);
  const occurrences: RuleOccurrence[] = [];

  for (const match of text.matchAll(regex)) {
    const secretRange = match.indices?.groups?.secret;
    if (secretRange !== undefined) {
      const [start, end] = secretRange;
      occurrences.push({ start, end, material: text.slice(start, end) });
      continue;
    }

    const start = match.index;
    occurrences.push({ start, end: start + match[0].length, material: match[0] });
  }

  return occurrences;
}

function isClaimed(start: number, end: number, claimed: readonly TextSpan[]): boolean {
  return claimed.some((span) => start < span.end && end > span.start);
}

/** Every span of `text` a rule or the entropy backstop claims, in priority order. */
function collectOccurrences(text: string, entropyThreshold: number): FoundOccurrence[] {
  const claimed: TextSpan[] = [];
  const found: FoundOccurrence[] = [];

  for (const rule of REDACTION_RULES) {
    for (const occurrence of occurrencesForRule(rule, text)) {
      if (isClaimed(occurrence.start, occurrence.end, claimed)) {
        continue;
      }
      claimed.push({ start: occurrence.start, end: occurrence.end });
      found.push({ ...occurrence, ruleId: rule.id });
    }
  }

  for (const span of findHighEntropyTokens(text, entropyThreshold, claimed)) {
    found.push({
      ...span,
      material: text.slice(span.start, span.end),
      ruleId: HIGH_ENTROPY_RULE_ID,
    });
  }

  found.sort((a, b) => a.start - b.start);
  return found;
}

function render(text: string, found: readonly FoundOccurrence[]): RedactionResult {
  let cursor = 0;
  let output = '';
  const matches: RedactionMatch[] = [];

  for (const occurrence of found) {
    output += text.slice(cursor, occurrence.start);
    const fingerprint = buildFingerprint(occurrence.ruleId, occurrence.material);
    output += fingerprint;
    matches.push({ rule: occurrence.ruleId, fingerprint });
    cursor = occurrence.end;
  }
  output += text.slice(cursor);

  return { text: output, matches };
}

/**
 * Deterministic by design: secret detection cannot depend on a model being up, so this
 * runs regex rules in priority order, then a high-entropy scan over whatever the rules
 * left unclaimed. `entropyThreshold` governs that backstop alone. No rule is gated on it,
 * since entropy over a short string measures length more than randomness. It is the
 * caller's `config.redaction.entropyThreshold`, defaulted here so the function stays
 * callable as `redact(text)` in isolation.
 */
export function redact(
  text: string,
  entropyThreshold: number = DEFAULT_ENTROPY_THRESHOLD,
): RedactionResult {
  if (text.length === 0) {
    return { text, matches: [] };
  }

  return render(text, collectOccurrences(text, entropyThreshold));
}

/**
 * One JSON field, redacted with its own key as context. Structured tool telemetry is the
 * normal shape of an agent trace, and there the key and the value are separate strings, so
 * every context-dependent rule (which is every rule that recognises a credential by the
 * name beside it) has nothing to fire on. Scanning `key=value` gives those rules the pair
 * they need and gives the entropy backstop the same view it has of embedded env dumps.
 *
 * Only the value's own range is ever fingerprinted. A span that starts inside the key is
 * clamped rather than dropped, so material that straddles the delimiter cannot survive by
 * hiding behind the name; the key itself is redacted separately by the caller, on its own
 * merits.
 *
 * The fallback is the point of the pair rule: a credential key whose value has no
 * recognisable shape of its own (an internal service key, a rotated password) is
 * fingerprinted whole. `isCredentialValue` is the embedded rule's own value class, so a
 * placeholder (`undefined`, `${VAR}`, `process.env.X`) or a sentence still survives.
 */
export function redactKeyedValue(
  key: string,
  value: string,
  entropyThreshold: number = DEFAULT_ENTROPY_THRESHOLD,
): RedactionResult {
  if (value.length === 0) {
    return { text: value, matches: [] };
  }

  const offset = key.length + 1;
  const found: FoundOccurrence[] = [];

  for (const occurrence of collectOccurrences(`${key}=${value}`, entropyThreshold)) {
    if (occurrence.end <= offset) {
      continue;
    }
    const start = Math.max(occurrence.start, offset) - offset;
    const end = occurrence.end - offset;
    found.push({ start, end, material: value.slice(start, end), ruleId: occurrence.ruleId });
  }

  if (found.length === 0 && isCredentialValue(value)) {
    found.push({ start: 0, end: value.length, material: value, ruleId: GENERIC_SECRET_RULE_ID });
  }

  return render(value, found);
}
