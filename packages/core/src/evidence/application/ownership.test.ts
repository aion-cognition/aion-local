import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ownershipCensusEstablished,
  ownershipIncidence,
  ownershipNominationHint,
  ownershipSummaryFor,
} from './ownership.js';
import { knewAt } from '../../infrastructure/graph/read-modes.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  advanceAckCursor,
  beginSubstratePairing,
} from '../../infrastructure/sqlite/publication-control.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { OWNERSHIP_SCOPES, ownershipVerdict } from '../domain/ownership.js';
import { durableRoleScope, SOURCE_STATE_SCOPE } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');
const LATER = new Date('2026-09-08T14:00:00.000Z');

function content(marker: string): ReflectionContent {
  return { turns: [{ role: 'user', text: `something about ${marker}` }] };
}

describe('ownership derived from the incidence records', () => {
  let dir: string;
  let store: SqliteStore;

  function countAllScopes(nodeId: string): void {
    for (const { role, direction } of OWNERSHIP_SCOPES) {
      establishScope(store.db, nodeId, durableRoleScope(role, direction), NOW);
    }
  }

  function summaryOf(
    nodeId: string,
    mode = checkedContext(),
  ): ReturnType<typeof ownershipSummaryFor> {
    return ownershipSummaryFor(
      store.db,
      nodeId,
      ownershipIncidence(store.db, [nodeId], mode),
      mode,
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-ownership-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    for (const [sourceId, sessionId] of [
      ['episode-a', 'session-a'],
      ['episode-b', 'session-b'],
    ] as const) {
      seedSource(store.db, {
        sourceId,
        sessionId,
        identity: 'agent-1',
        content: content(sourceId),
        now: NOW,
      });
    }
    countAllScopes('claim-1');
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('names the session behind every current source that carries the node', () => {
    commitIncidence(store.db, {
      sourceId: 'episode-a',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'own-a',
      at: NOW,
    });
    commitIncidence(store.db, {
      sourceId: 'episode-b',
      nodeId: 'claim-1',
      role: 'mention',
      operationId: 'own-b',
      at: NOW,
    });

    expect(summaryOf('claim-1')).toEqual({
      sessions: ['session-a', 'session-b'],
      unknownAttribution: false,
      censusEstablished: true,
    });
  });

  /**
   * A forgotten episode may not be quoted, so it may not decide whose memory a node is either.
   * The graph predicate this replaced walked the episode hop without asking, and a session whose
   * only co-owner had been forgotten kept reading its own record as shared.
   */
  it('drops a forgotten mentioning source from the verdict', () => {
    commitIncidence(store.db, {
      sourceId: 'episode-a',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'own-a',
      at: NOW,
    });
    commitIncidence(store.db, {
      sourceId: 'episode-b',
      nodeId: 'claim-1',
      role: 'mention',
      operationId: 'own-b',
      at: NOW,
    });
    expect(ownershipVerdict(summaryOf('claim-1'), 'session-a')).toBe('shared');

    commitSourceState(store.db, {
      sourceId: 'episode-b',
      stateKind: 'forgotten',
      operationId: 'forget-b',
      at: LATER,
    });

    expect(summaryOf('claim-1').sessions).toEqual(['session-a']);
    expect(ownershipVerdict(summaryOf('claim-1'), 'session-a')).toBe('own_only');
  });

  it('drops an incidence the writers have retired', () => {
    commitIncidence(store.db, {
      sourceId: 'episode-a',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'own-a',
      at: NOW,
    });
    commitIncidence(store.db, {
      sourceId: 'episode-b',
      nodeId: 'claim-1',
      role: 'mention',
      operationId: 'own-b',
      at: NOW,
      currency: 'closed',
    });

    expect(summaryOf('claim-1').sessions).toEqual(['session-a']);
  });

  /** A role nothing calls ownership says where a node sits, not whose it is. */
  it('ignores a role outside the ownership set', () => {
    commitIncidence(store.db, {
      sourceId: 'episode-b',
      nodeId: 'claim-1',
      role: 'raw_order',
      operationId: 'order-b',
      at: NOW,
    });

    expect(summaryOf('claim-1').sessions).toEqual([]);
  });

  it('carries the capturing session of a node that is its own source', () => {
    countAllScopes('episode-a');

    expect(summaryOf('episode-a')).toEqual({
      sessions: ['session-a'],
      unknownAttribution: false,
      censusEstablished: true,
    });
  });

  it('reports a source with no record as attribution nobody can account for', () => {
    commitIncidence(store.db, {
      sourceId: 'episode-missing',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'own-missing',
      at: NOW,
    });
    const summary = summaryOf('claim-1');

    expect(summary).toMatchObject({ sessions: [], unknownAttribution: true });
    expect(ownershipVerdict(summary, 'session-a')).toBe('unknown');
  });

  /**
   * A knowledge-time question against a state chain nobody counted cannot say whether the source
   * was suppressed then, so the session it names is not a session anybody may act on.
   */
  it('reports an unprovable historical vantage as unknown attribution', () => {
    commitIncidence(store.db, {
      sourceId: 'episode-a',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'own-a',
      at: NOW,
    });
    const historical = checkedContext({ mode: knewAt(LATER), now: LATER });

    expect(summaryOf('claim-1', historical)).toMatchObject({
      sessions: [],
      unknownAttribution: true,
    });

    establishScope(store.db, 'episode-a', SOURCE_STATE_SCOPE, NOW);

    expect(summaryOf('claim-1', historical).sessions).toEqual(['session-a']);
  });

  it('reports an uncounted scope rather than treating what it read as the whole set', () => {
    expect(ownershipCensusEstablished(store.db, 'claim-2')).toBe(false);
    expect(summaryOf('claim-2').censusEstablished).toBe(false);
  });
});

describe('the bound a nomination trusts a stored summary up to', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-ownership-hint-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers with nothing before a substrate is paired', () => {
    expect(ownershipNominationHint(store.db)).toBeUndefined();
  });

  it('answers with this substrate and the sequence it has acknowledged', () => {
    const pairing = beginSubstratePairing(store.db, 1);
    advanceAckCursor(store.db, '12', NOW.toISOString());

    expect(ownershipNominationHint(store.db)).toEqual({
      substrateId: pairing.substrateId,
      acknowledgedSequence: '12',
    });
  });

  /** An unreadable control record is not a bound, and a bound nobody has is no discount at all. */
  it('answers with nothing when the control record cannot be read', () => {
    beginSubstratePairing(store.db, 1);
    store.db.prepare('ALTER TABLE publication_control RENAME TO publication_control_probe').run();
    try {
      expect(ownershipNominationHint(store.db)).toBeUndefined();
    } finally {
      store.db.prepare('ALTER TABLE publication_control_probe RENAME TO publication_control').run();
    }
  });
});
