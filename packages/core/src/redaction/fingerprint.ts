import { createHash } from 'node:crypto';

/**
 * A stable, content-derived fingerprint: the same secret always hashes to the same
 * 6 hex chars, so co-occurrence structure (the same credential appearing across
 * episodes) survives without the material ever being stored.
 */
export function buildFingerprint(ruleId: string, material: string): string {
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  return `⟨secret:${ruleId}:${digest.slice(0, 6)}⟩`;
}

/** What `buildFingerprint` writes: `⟨secret:<rule-id>:<6 hex chars>⟩`. */
export const FINGERPRINT_PATTERN = /⟨secret:[a-z0-9-]+:[0-9a-f]{6}⟩/g;

/**
 * What a fingerprint stands in as while the detector looks, and not the empty string.
 * Removing the token outright closes the gap between `api_key:` and whatever the next line
 * names, and the generic assignment rule then reads the next line's field name as this line's
 * value: a fresh match over text that holds no secret at all. `redacted` is the one
 * placeholder that rule's own lookahead exempts, so a fingerprint reads as what it is.
 */
export const FINGERPRINT_PLACEHOLDER = 'redacted';

/**
 * Stored text with every fingerprint replaced by the inert placeholder, which is what any
 * detector re-run over already-redacted material has to look at.
 *
 * `redact()` has no way to know a span is its own earlier output: the fingerprint token embeds
 * the rule id after a colon, which is exactly the `key: value` shape `generic-secret-assignment`
 * matches on. Scanning clean text finds that match again, so a node stays flagged forever, the
 * operation that rewrites it can never move the count it is scored on, and `aion doctor` reports
 * a leak that was closed.
 */
export function withoutFingerprints(text: string): string {
  return text.replace(FINGERPRINT_PATTERN, FINGERPRINT_PLACEHOLDER);
}
