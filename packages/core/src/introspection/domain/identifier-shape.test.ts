import { describe, expect, it } from 'vitest';

import { identifierShape } from './identifier-shape.js';

describe('identifierShape', () => {
  const SHA1 = '07e5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a1';
  const SHA256 = '07e5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4b2907e5c3a18f6d4b29';

  it('matches a 40-hex SHA-1 and a 64-hex SHA-256, case-insensitively', () => {
    expect(identifierShape(SHA1, 'concept')).toBe('sha');
    expect(identifierShape(SHA1.toUpperCase(), 'concept')).toBe('sha');
    expect(identifierShape(SHA256, 'tool')).toBe('sha');
  });

  it('rejects hex runs one digit short or long of a real digest length', () => {
    expect(identifierShape(SHA1.slice(0, -1), 'concept')).toBe('none');
    expect(identifierShape(`${SHA1}0`, 'concept')).toBe('none');
  });

  it('matches standard UUID dash placement', () => {
    expect(identifierShape('550e8400-e29b-41d4-a716-446655440000', 'concept')).toBe('uuid');
    expect(identifierShape('550E8400-E29B-41D4-A716-446655440000', 'concept')).toBe('uuid');
  });

  it('rejects a UUID with a dash out of place or a segment short', () => {
    expect(identifierShape('550e8400e29b-41d4-a716-446655440000', 'concept')).toBe('none');
    expect(identifierShape('550e8400-e29b-41d4-a716-44665544000', 'concept')).toBe('none');
  });

  it('matches the code-Na agent id prefix over a hex tail', () => {
    expect(identifierShape('code-Na1a2b3c4d5e6f', 'tool')).toBe('agent_id');
    expect(identifierShape('code-NA1A2B3C4D5E6F', 'tool')).toBe('agent_id');
  });

  it('rejects a code-Na prefix with too short a tail, and a similar but wrong prefix', () => {
    expect(identifierShape('code-Na1a2b3', 'tool')).toBe('none');
    expect(identifierShape('code-Nope1a2b3c4d5e6f', 'tool')).toBe('none');
  });

  it('matches a name carrying two or more path separators', () => {
    expect(identifierShape('packages/core/src/index.ts', 'tool')).toBe('path');
    expect(identifierShape('C:\\Users\\ryan\\project', 'tool')).toBe('path');
  });

  it('rejects a single separator and a slash-bearing sentence', () => {
    expect(identifierShape('README.md', 'concept')).toBe('none');
    expect(identifierShape('core/index.ts', 'tool')).toBe('none');
    expect(identifierShape('either/or, then decide', 'concept')).toBe('none');
  });

  it('never matches a plain word or name, whatever the declared type', () => {
    expect(identifierShape('PostgreSQL', 'tool')).toBe('none');
    expect(identifierShape('Ryan Huber', 'person')).toBe('none');
    expect(identifierShape('the sync engine', 'project')).toBe('none');
    expect(identifierShape('', 'concept')).toBe('none');
  });
});
