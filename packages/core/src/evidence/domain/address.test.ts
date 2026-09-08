import { describe, expect, it } from 'vitest';

import {
  evidenceAddressFromKey,
  evidenceRequestKey,
  idAddress,
  partAddress,
  sameEvidenceAddress,
  addressSourceId,
} from './address.js';

describe('evidence addresses', () => {
  it('keys an id and a part differently and round-trips both', () => {
    const id = idAddress('episode-1');
    const part = partAddress('episode-1', 'observation', 2);

    expect(evidenceRequestKey(id)).toBe('["id","episode-1"]');
    expect(evidenceRequestKey(part)).toBe('["part","episode-1","observation",2]');
    expect(evidenceAddressFromKey(evidenceRequestKey(id))).toEqual(id);
    expect(evidenceAddressFromKey(evidenceRequestKey(part))).toEqual(part);
  });

  it('keeps two parts of one source apart', () => {
    const first = partAddress('episode-1', 'observation', 0);
    const second = partAddress('episode-1', 'observation', 1);

    expect(evidenceRequestKey(first)).not.toBe(evidenceRequestKey(second));
    expect(sameEvidenceAddress(first, second)).toBe(false);
    expect(sameEvidenceAddress(first, partAddress('episode-1', 'observation', 0))).toBe(true);
  });

  it('names the source a part belongs to and nothing for a bare id', () => {
    expect(addressSourceId(partAddress('episode-1', 'turn', 0))).toBe('episode-1');
    expect(addressSourceId(idAddress('episode-1'))).toBeUndefined();
  });

  it('refuses a key this substrate did not produce', () => {
    expect(() => evidenceAddressFromKey('["id"]')).toThrow(/not an address/);
    expect(() => evidenceAddressFromKey('["part","episode-1","summary",0]')).toThrow(
      /not an address/,
    );
    expect(() => evidenceAddressFromKey('["part","episode-1","turn","first"]')).toThrow(
      /not an address/,
    );
    expect(() => evidenceAddressFromKey('{"kind":"id"}')).toThrow(/not a tuple/);
  });
});
