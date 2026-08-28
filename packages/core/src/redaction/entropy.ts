/**
 * Opaque-token alphabet: alnum plus the symbols base64/base64url and common token
 * schemes use. `/` and `.` are deliberately excluded — both are frequent in file
 * paths and URLs, which must survive unredacted, and their absence only costs
 * recall on the rare secret that leans on them instead of `-`/`_`.
 */
const ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9_+=-]{20,}/g;

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
 * The backstop for secrets the rule corpus misses: any opaque run of 20+ chars whose
 * entropy clears the threshold, skipping ranges a rule already claimed. The 20-char
 * floor is doing real work here, not just noise reduction — it's why short base64
 * strings survive regardless of how random-looking they are.
 */
export function findHighEntropyTokens(
  text: string,
  threshold: number,
  claimed: readonly TextSpan[],
): TextSpan[] {
  const found: TextSpan[] = [];

  for (const match of text.matchAll(ENTROPY_TOKEN_PATTERN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;

    if (overlapsAny(start, end, claimed) || overlapsAny(start, end, found)) {
      continue;
    }

    if (shannonEntropy(match[0]) >= threshold) {
      found.push({ start, end });
    }
  }

  return found;
}
