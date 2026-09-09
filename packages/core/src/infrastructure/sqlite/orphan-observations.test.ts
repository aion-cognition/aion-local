import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteStore } from './database.js';
import {
  clearOrphanQualification,
  readOrphanObservation,
  recordOrphanQualification,
} from './orphan-observations.js';

const FIRST = new Date('2026-08-01T02:00:00.000Z');
const SECOND = new Date('2026-08-15T02:00:00.000Z');
const THIRD = new Date('2026-09-01T02:00:00.000Z');
const NODE = 'node-1';

describe('orphan qualification', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-orphan-observations-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function certify(
    now: Date,
    evidenceRevision: Record<string, string>,
    disposition: 'unsupported' | 'supported' | 'unknown' = 'unsupported',
  ): string {
    return recordOrphanQualification(store.db, {
      nodeId: NODE,
      evidenceRevision,
      policyRevision: 1,
      disposition,
      reason: 'certified',
      now,
    }).firstVerifiedAt;
  }

  it('starts the clock at the first certification', () => {
    expect(certify(FIRST, { 'sqlite:mention:in': 'token-a' })).toBe(FIRST.toISOString());
  });

  it('leaves the clock alone while the same scopes certify the same thing', () => {
    certify(FIRST, { 'sqlite:mention:in': 'token-a' });

    expect(certify(SECOND, { 'sqlite:mention:in': 'token-a' })).toBe(FIRST.toISOString());
  });

  it('restarts the clock when a scope the certification rested on moves', () => {
    certify(FIRST, { 'sqlite:mention:in': 'token-a' });

    // Support was added and taken away again inside the gap, and nothing here saw it. The
    // interval is unaccounted for, so the age it would have contributed is not claimed.
    expect(certify(SECOND, { 'sqlite:mention:in': 'token-b' })).toBe(SECOND.toISOString());
  });

  it('restarts the clock when the disposition changes and again when it changes back', () => {
    certify(FIRST, { 'sqlite:mention:in': 'token-a' });
    certify(SECOND, { 'sqlite:mention:in': 'token-a' }, 'supported');

    expect(certify(THIRD, { 'sqlite:mention:in': 'token-a' })).toBe(THIRD.toISOString());
  });

  it('is insensitive to the order the scopes are listed in', () => {
    certify(FIRST, { a: '1', b: '2' });

    expect(certify(SECOND, { b: '2', a: '1' })).toBe(FIRST.toISOString());
  });

  it('records what it certified, so a later reader sees the disposition and its reason', () => {
    certify(FIRST, { 'sqlite:mention:in': 'token-a' }, 'unknown');

    expect(readOrphanObservation(store.db, NODE)).toMatchObject({
      nodeId: NODE,
      disposition: 'unknown',
      reason: 'certified',
      policyRevision: 1,
    });
  });

  it('drops a qualification outright for a node that has left the population', () => {
    certify(FIRST, { 'sqlite:mention:in': 'token-a' });
    clearOrphanQualification(store.db, NODE);

    expect(readOrphanObservation(store.db, NODE)).toBeUndefined();
  });
});
