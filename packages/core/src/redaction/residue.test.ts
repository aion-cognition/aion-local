import { describe, expect, it } from 'vitest';
import { buildFingerprint, withoutFingerprints } from './fingerprint.js';
import { DEFAULT_ENTROPY_THRESHOLD, redact } from './redact.js';

/**
 * The residue scan is `redact` run over stored text, so what needs proving here is the claim
 * it rests on: the current rules still recognise the material an older ruleset wrote through.
 * The graph half is a read and is covered by the doctor check that calls it.
 */
describe('what a residue scan would find', () => {
  it('recognises credential and secret patterns stored in plaintext', () => {
    const stored = [
      'pasted into the runbook: AKIAIOSFODNN7EXAMPLE with secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY.',
      '{"input":{"command":"env","context":{"nested":{"aws_secret_access_key":"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}}}}',
    ];

    for (const text of stored) {
      expect(redact(text, DEFAULT_ENTROPY_THRESHOLD).matches.length).toBeGreaterThan(0);
    }
  });

  it('leaves ordinary stored prose alone, so the count means what it says', () => {
    const clean = 'We will not shard the orders table; the split migration takes 4 minutes.';

    expect(redact(clean, DEFAULT_ENTROPY_THRESHOLD).matches).toEqual([]);
  });

  /**
   * The count has to be closable. A fingerprint is `key: value` shaped, so a node the purge
   * has already rewritten matches `generic-secret-assignment` on the next scan and stays
   * flagged: the operation could never move the metric it is scored on, and `aion doctor`
   * would report a leak that was closed.
   */
  it('does not count its own earlier fix as a fresh leak', () => {
    const fixed = `api_key: ${buildFingerprint('generic-secret-assignment', 'the old value')}`;

    expect(redact(fixed, DEFAULT_ENTROPY_THRESHOLD).matches.length).toBeGreaterThan(0);
    expect(redact(withoutFingerprints(fixed), DEFAULT_ENTROPY_THRESHOLD).matches).toEqual([]);
  });

  it('still finds a real leak sitting beside an earlier fix', () => {
    const mixed =
      `api_key: ${buildFingerprint('generic-secret-assignment', 'the old value')}\n` +
      'aws_access_key_id: AKIAIOSFODNN7EXAMPLE';

    const matches = redact(withoutFingerprints(mixed), DEFAULT_ENTROPY_THRESHOLD).matches;
    expect(matches.map((match) => match.rule)).toContain('aws-access-key');
  });
});
