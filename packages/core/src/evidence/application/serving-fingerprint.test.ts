import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readItemMetadata } from './metadata.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import type { FusedItem } from '../../recall/domain/fusion.js';
import { servedFingerprint } from '../../recall/domain/session-dedup.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { evidenceRequestKey, idAddress } from '../domain/address.js';
import { RequestBudget } from '../domain/budget.js';
import { checkedContext, seedSource } from '../test-support/evidence.fixture.js';

/**
 * What the serving fingerprint does and does not move on, read through the boundary that supplies
 * its semantic half. The hash itself is unchanged; what this pins is that the metadata the
 * resolver hands it is stable under the orderings a graph is free to return.
 */

const NOW = new Date('2026-09-08T10:00:00.000Z');
const CAPTURES = ['episode-a', 'episode-b'] as const;

function content(marker: string): ReflectionContent {
  return { turns: [{ role: 'user', text: `a note about ${marker}` }] };
}

/** A graph that answers the two lineage reads with the captures in the order it is given. */
function graphReturning(captures: readonly string[]): Driver {
  const executeQuery = (cypher: string): Promise<unknown> => {
    if (cypher.includes('capture_ids')) {
      return Promise.resolve({
        records: [{ toObject: () => ({ id: 'claim-1', capture_ids: [...captures] }) }],
      });
    }
    if (cypher.includes('AS parents')) {
      return Promise.resolve({
        records: captures.map((id) => ({
          toObject: () => ({
            id,
            parents: [],
            unresolved: 0,
            narrated: false,
            citations: [],
            resolved_citations: 0,
          }),
        })),
      });
    }
    return Promise.resolve({ records: [] });
  };
  return { executeQuery } as unknown as Driver;
}

function item(): FusedItem {
  return {
    id: 'claim-1',
    labels: ['Insight', 'Memory', 'AionNode'],
    content: 'the migration took 45 seconds',
    rationale: { method: 'vector', score: 0.8 },
    relevance: 0.8,
    measured: 0.8,
    score: 0.02,
    currency: 'current',
  };
}

describe('the semantic metadata behind a served fingerprint', () => {
  let dir: string;
  let store: SqliteStore;

  async function fingerprintUnder(captures: readonly string[]): Promise<string> {
    const reading = await readItemMetadata(
      { driver: graphReturning(captures), db: store.db },
      {
        ids: ['claim-1'],
        context: checkedContext(),
        budget: new RequestBudget(),
        maxRoots: 8,
      },
    );
    const value = reading.results.get(evidenceRequestKey(idAddress('claim-1')))?.value;
    if (value === undefined) {
      throw new Error('the reading answered for the claim');
    }
    return servedFingerprint(item(), value.provenance);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-serving-fingerprint-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    for (const sourceId of CAPTURES) {
      seedSource(store.db, {
        sourceId,
        sessionId: 'session-a',
        identity: 'agent-1',
        content: content(sourceId),
        now: NOW,
      });
    }
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Two roots reached in either order are the same two roots. The sort happens where the metadata
   * is assembled, so a graph free to return its matches in any order cannot make a memory look
   * like it changed.
   */
  it('holds still when the graph returns the same roots in another order', async () => {
    const forward = await fingerprintUnder(CAPTURES);
    const reversed = await fingerprintUnder([...CAPTURES].reverse());

    expect(reversed).toBe(forward);
  });

  it('names the roots in one order whichever way they arrived', async () => {
    const reading = await readItemMetadata(
      { driver: graphReturning([...CAPTURES].reverse()), db: store.db },
      { ids: ['claim-1'], context: checkedContext(), budget: new RequestBudget(), maxRoots: 8 },
    );

    expect(
      reading.results.get(evidenceRequestKey(idAddress('claim-1')))?.value?.provenance.roots,
    ).toEqual([...CAPTURES]);
  });
});
