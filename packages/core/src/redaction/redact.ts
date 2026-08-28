import { findHighEntropyTokens, type TextSpan } from './entropy.js';
import { buildFingerprint } from './fingerprint.js';
import { HIGH_ENTROPY_RULE_ID, REDACTION_RULES, type RedactionRule } from './rules.js';

/**
 * Mirrors `DEFAULTS.redaction.entropyThreshold` in `config/defaults.ts`. Duplicated
 * rather than imported: this module stays a standalone, config-free pure function,
 * and callers that hold a loaded `Config` pass its value in explicitly instead.
 */
export const DEFAULT_ENTROPY_THRESHOLD = 4.5;

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
    const secretRange = match.indices?.groups?.['secret'];
    if (secretRange !== undefined) {
      const [start, end] = secretRange;
      occurrences.push({ start, end, material: text.slice(start, end) });
      continue;
    }

    const start = match.index ?? 0;
    occurrences.push({ start, end: start + match[0].length, material: match[0] });
  }

  return occurrences;
}

function isClaimed(start: number, end: number, claimed: readonly TextSpan[]): boolean {
  return claimed.some((span) => start < span.end && end > span.start);
}

/**
 * Deterministic by design (PRD §12): secret detection cannot depend on a model being
 * up, so this runs regex rules in priority order, then a high-entropy scan over
 * whatever the rules left unclaimed. `entropyThreshold` governs that backstop alone —
 * no rule is gated on it, since entropy over a short string measures length more than
 * randomness. It is the caller's `config.redaction.entropyThreshold`, defaulted here so
 * the function stays callable as `redact(text)` in isolation.
 */
export function redact(
  text: string,
  entropyThreshold: number = DEFAULT_ENTROPY_THRESHOLD,
): RedactionResult {
  if (text.length === 0) {
    return { text, matches: [] };
  }

  const claimed: TextSpan[] = [];
  const found: Array<RuleOccurrence & { ruleId: string }> = [];

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
    found.push({ ...span, material: text.slice(span.start, span.end), ruleId: HIGH_ENTROPY_RULE_ID });
  }

  found.sort((a, b) => a.start - b.start);

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
