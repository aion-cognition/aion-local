import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { readRelationScope } from './dependencies.js';
import {
  acknowledgeMintedNodeState,
  advanceNodeState,
  discardMintedNodeState,
  nodeStateScope,
  prepareMintedNodeState,
} from './node-state.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  readScopeMirror,
  readScopeVersion,
  scopeSupportsVerifiedEmpty,
} from '../../infrastructure/sqlite/evidence-scope.js';

const AT = new Date('2026-09-13T06:00:00.000Z');
const NODE = 'claim-1';

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
});

afterEach(() => {
  store.close();
});

/** What a reader gets: a verified dependency, or nothing to bind a judgment on. */
function reading(): ReturnType<typeof readRelationScope> {
  return readRelationScope(store.db, {
    kind: 'node',
    endpointId: NODE,
    scope: nodeStateScope(NODE).relationClass,
    empty: false,
  });
}

describe('a node counted from the write that minted it', () => {
  it('leaves the state unreadable until the minting write acknowledges', () => {
    expect(reading().status).toBe('unverified');

    prepareMintedNodeState(store.db, NODE, 'op-1', AT);

    // Parked, not published: a prepared advance says nothing about the population yet.
    expect(reading().status).toBe('unverified');
    expect(scopeSupportsVerifiedEmpty(store.db, nodeStateScope(NODE))).toBe(false);
  });

  it('establishes the census and its mirror together, so the state binds', () => {
    prepareMintedNodeState(store.db, NODE, 'op-1', AT);

    expect(acknowledgeMintedNodeState(store.db, NODE, 'op-1', AT.toISOString())).toBe(true);

    const bound = reading();
    expect(bound.status).toBe('verified');
    expect(scopeSupportsVerifiedEmpty(store.db, nodeStateScope(NODE))).toBe(true);
    expect(readScopeMirror(store.db, nodeStateScope(NODE))?.mirroredRevision).toBe(
      readScopeVersion(store.db, nodeStateScope(NODE))?.publishedRevision,
    );
  });

  it('moves the version when a writer changes the state, so a held reading goes stale', () => {
    prepareMintedNodeState(store.db, NODE, 'op-1', AT);
    acknowledgeMintedNodeState(store.db, NODE, 'op-1', AT.toISOString());
    const held = reading();

    advanceNodeState(store.db, NODE, 'op-2', '2026-09-13T07:00:00.000Z');

    const moved = reading();
    expect(moved.status).toBe('verified');
    if (held.status !== 'verified' || moved.status !== 'verified') {
      throw new Error('both readings bind');
    }
    expect(moved.dependency.version).not.toBe(held.dependency.version);
  });

  it('claims nothing when a refusal drops the minting write', () => {
    prepareMintedNodeState(store.db, NODE, 'op-1', AT);

    discardMintedNodeState(store.db, NODE, 'op-1', AT);

    expect(reading().status).toBe('unverified');
    expect(scopeSupportsVerifiedEmpty(store.db, nodeStateScope(NODE))).toBe(false);
    expect(readScopeMirror(store.db, nodeStateScope(NODE))).toBeUndefined();
  });

  it('refuses to count a node a later acknowledgment does not hold the slot for', () => {
    prepareMintedNodeState(store.db, NODE, 'op-1', AT);

    expect(acknowledgeMintedNodeState(store.db, NODE, 'op-other', AT.toISOString())).toBe(false);
    expect(reading().status).toBe('unverified');
  });

  it('advances a node nobody counted without claiming a census for it', () => {
    advanceNodeState(store.db, NODE, 'op-2', AT.toISOString());

    // A writer that changed one node has counted no population, so the reading stays unproved.
    expect(readScopeMirror(store.db, nodeStateScope(NODE))?.mirroredRevision).toBe(1);
    expect(reading().status).toBe('unverified');
  });
});
