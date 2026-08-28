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
