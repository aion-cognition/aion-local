import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  looksLikeNodeId,
  MissingForgetTargetError,
  parseForgetFlags,
  UnknownForgetOptionError,
} from './forget.js';

describe('parseForgetFlags', () => {
  it('reads a bare id or query as the target', () => {
    expect(parseForgetFlags(['node-1'])).toEqual({ target: 'node-1', yes: false });
  });

  it('joins an unquoted multi-word query and reads --yes in either position', () => {
    expect(parseForgetFlags(['the', 'old', 'decision', '--yes'])).toEqual({
      target: 'the old decision',
      yes: true,
    });
    expect(parseForgetFlags(['--yes', 'the', 'old', 'decision'])).toEqual({
      target: 'the old decision',
      yes: true,
    });
  });

  it('rejects a missing target and an unknown option', () => {
    expect(() => parseForgetFlags([])).toThrow(MissingForgetTargetError);
    expect(() => parseForgetFlags(['--bogus'])).toThrow(UnknownForgetOptionError);
  });
});

describe('looksLikeNodeId', () => {
  it('accepts a randomUUID, whichever case', () => {
    const id = randomUUID();
    expect(looksLikeNodeId(id)).toBe(true);
    expect(looksLikeNodeId(id.toUpperCase())).toBe(true);
  });

  it('accepts a 64-character hex id, the shape cognitive nodes mint', () => {
    expect(looksLikeNodeId('a'.repeat(64))).toBe(true);
  });

  it('rejects ordinary query text', () => {
    expect(looksLikeNodeId('the old decision about webhooks')).toBe(false);
    expect(looksLikeNodeId('webhooks')).toBe(false);
    expect(looksLikeNodeId('')).toBe(false);
  });

  it('rejects an id-shaped string of the wrong length', () => {
    expect(looksLikeNodeId('a'.repeat(63))).toBe(false);
    expect(looksLikeNodeId('a'.repeat(65))).toBe(false);
  });
});
