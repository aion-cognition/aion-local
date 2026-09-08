import { createHash } from 'node:crypto';

import type { JsonValue } from './types.js';

/** Stable bytes bind an operation's data, not object insertion order or executable values. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('publication data must contain only finite JSON values');
}

export function parseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  canonicalJson(parsed);
  return parsed as JsonValue;
}

export function publicationDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Publication clocks are stored canonically; an invalid stored value is not a horizon. */
export function publicationTimestamp(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error('invalid publication timestamp');
  }
  return value;
}

export function decimalSequence(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('invalid publication sequence');
  }
  const number = BigInt(value);
  if (number > 9_223_372_036_854_775_807n) {
    throw new Error('publication sequence exceeds the storage range');
  }
  return number;
}

/** Binary key ordering agrees with SQLite for the identifiers stored by this protocol. */
export function comparePublicationKeys(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
