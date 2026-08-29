/**
 * Opaque-token alphabet: alnum plus the full base64 alphabet (`+ / =`) and the `_ -` that
 * base64url and env-var names add. `/` belongs in the class: standard base64 carries it, so
 * roughly half of all AWS secret access keys contain one, and excluding it splits such a key
 * into fragments that never reach the length floor to be scored at all. Paths and URLs
 * survive on their own entropy instead, measured between 3.5 and 4.2 bits/char against a
 * 4.5 threshold and pinned by the false-positive corpus. `.` stays out of the class, which
 * bounds most of them before they grow long enough to matter.
 */
const ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9_+/=-]{20,}/g;

/**
 * `NAME=value` inside one candidate token. `_` and `=` are both in the token class, so an
 * env-var name and its value match as a single token and the name's own characters enter
 * the score. That is a leak: `AWS_ACCESS_KEY_ID=<value>` scores 4.145 and survives while
 * `aws_access_key_id=<same value>` scores 4.608 and is redacted. The value needs 8+
 * characters, which no base64 padding run (`==` at the end of a token) can supply.
 */
const NAMED_ASSIGNMENT = /^(?<name>[A-Za-z][A-Za-z0-9_-]*)=(?<value>.{8,})$/;

export type TextSpan = {
  start: number;
  end: number;
};

/** Shannon entropy in bits/char over the string's own symbol distribution. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }

  return bits;
}

function overlapsAny(start: number, end: number, spans: readonly TextSpan[]): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

/**
 * What a candidate token is worth, and how much of it to claim. A token carrying a
 * `NAME=value` assignment is scored three more ways (the value alone, and the whole token
 * with the name folded to each case) and the largest score decides. Folding both ways is
 * what makes the verdict independent of how the name was cased: the two casings of one name
 * produce the same pair of folds. The raw token score stays the fallback, so the assignment
 * path only ever adds ways to clear the threshold and nothing the plain scan catches can
 * start slipping through.
 *
 * When an assignment-derived score is what clears the threshold, only the value is claimed.
 * The name is not secret material and leaving it in place keeps the surrounding text
 * readable (`aws_access_key_id=⟨secret:high-entropy:…⟩`).
 */
function scoreCandidate(token: string, threshold: number): { score: number; valueOffset: number } {
  const assignment = NAMED_ASSIGNMENT.exec(token);
  const name = assignment?.groups?.['name'];
  const value = assignment?.groups?.['value'];

  if (name !== undefined && value !== undefined) {
    const valueScore = Math.max(
      shannonEntropy(value),
      shannonEntropy(`${name.toLowerCase()}=${value}`),
      shannonEntropy(`${name.toUpperCase()}=${value}`),
    );
    if (valueScore >= threshold) {
      return { score: valueScore, valueOffset: token.length - value.length };
    }
  }

  return { score: shannonEntropy(token), valueOffset: 0 };
}

/**
 * The backstop for secrets the rule corpus misses: any opaque run of 20+ chars whose
 * entropy clears the threshold, skipping ranges a rule already claimed. The 20-char floor
 * is why short base64 strings survive regardless of how random-looking they are.
 */
export function findHighEntropyTokens(
  text: string,
  threshold: number,
  claimed: readonly TextSpan[],
): TextSpan[] {
  const found: TextSpan[] = [];

  for (const match of text.matchAll(ENTROPY_TOKEN_PATTERN)) {
    const tokenStart = match.index ?? 0;
    const { score, valueOffset } = scoreCandidate(match[0], threshold);
    if (score < threshold) {
      continue;
    }

    const start = tokenStart + valueOffset;
    const end = tokenStart + match[0].length;
    if (overlapsAny(start, end, claimed) || overlapsAny(start, end, found)) {
      continue;
    }

    found.push({ start, end });
  }

  return found;
}
