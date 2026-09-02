import { describe, expect, it } from 'vitest';

import { buildFingerprint, fingerprintProvenance, withoutFingerprints } from './fingerprint.js';
import { DEFAULT_ENTROPY_THRESHOLD, redact } from './redact.js';

describe('fingerprintProvenance', () => {
  it('reads the rule ids and span count off a redacted text, from its own fingerprints', () => {
    const { text } = redact('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');

    expect(fingerprintProvenance(text)).toEqual({
      ruleIds: ['aws-access-key'],
      spanCount: 1,
    });
  });

  it('deduplicates rule ids across repeated spans but still counts every span', () => {
    const { text } = redact('first key AKIAIOSFODNN7EXAMPLE, second key AKIAABCDEFGHIJ123456');

    expect(fingerprintProvenance(text)).toEqual({
      ruleIds: ['aws-access-key'],
      spanCount: 2,
    });
  });

  it('returns undefined for text that holds no fingerprint at all', () => {
    expect(fingerprintProvenance('nothing sensitive here')).toBeUndefined();
  });
});

describe('withoutFingerprints', () => {
  it('does not let two adjacent fingerprints fuse into a fresh generic-secret match', () => {
    const first = buildFingerprint('generic-secret-assignment', 'the old value');
    const second = buildFingerprint('aws-access-key', 'AKIAIOSFODNN7EXAMPLE');
    const adjacent = `api_key: ${first}${second}`;

    const { matches } = redact(withoutFingerprints(adjacent), DEFAULT_ENTROPY_THRESHOLD);

    expect(matches).toEqual([]);
  });
});
