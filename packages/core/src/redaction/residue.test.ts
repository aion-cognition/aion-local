import { describe, expect, it } from 'vitest';
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
});
