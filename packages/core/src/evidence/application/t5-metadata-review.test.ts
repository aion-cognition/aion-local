import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvidenceResolver, type EvidenceCheckpointReader } from './resolver.js';
import { knewAt } from '../../infrastructure/graph/read-modes.js';
import * as subjectGraph from '../../infrastructure/graph/subject-family.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { EVIDENCE_LIMITS } from '../domain/budget.js';
import { durableRoleScope } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');
const logger = { warn: vi.fn() };

const CONTENT: ReflectionContent = {
  turns: [{ role: 'user', text: 'the migration took 45 seconds', occurred_at: NOW.toISOString() }],
};

type QueryLog = { readonly cyphers: string[] };

/**
 * Answers the two lineage reads a metadata batch makes, and counts them. `unresolved` on the
 * capture is what a claim with a reference nobody could place reports.
 */
function lineageDriver(input: { readonly unresolved: number; readonly log: QueryLog }): Driver {
  const executeQuery = (cypher: string): Promise<unknown> => {
    input.log.cyphers.push(cypher);
    if (cypher.includes('capture_ids')) {
      return Promise.resolve({
        records: [
          { toObject: () => ({ id: 'claim-1', capture_ids: ['episode-1'] }) },
          { toObject: () => ({ id: 'claim-2', capture_ids: ['episode-1'] }) },
        ],
      });
    }
    if (cypher.includes('AS parents')) {
      return Promise.resolve({
        records: [
          {
            toObject: () => ({
              id: 'episode-1',
              parents: [],
              unresolved: input.unresolved,
              narrated: false,
              citations: [],
              resolved_citations: 0,
            }),
          },
        ],
      });
    }
    return Promise.resolve({ records: [] });
  };
  return { executeQuery } as unknown as Driver;
}

describe('the evidence resolver', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-resolver-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    seedSource(store.db, {
      sourceId: 'episode-1',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: CONTENT,
      now: NOW,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function resolver(options: {
    readonly driver: Driver;
    readonly publications?: EvidenceCheckpointReader;
  }): EvidenceResolver {
    return new EvidenceResolver({
      driver: options.driver,
      db: store.db,
      logger,
      ...(options.publications === undefined ? {} : { publications: options.publications }),
    });
  }

  it('enforces the declared metadata byte budget', async () => {
    const reader = new EvidenceResolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      db: store.db,
      logger,
      limits: { ...EVIDENCE_LIMITS, metadataBytes: 1 },
    });
    const result = await reader.resolveMetadata(['claim-1'], checkedContext(), { maxRoots: 4 });
    expect(result.issues.some((issue) => issue.reason === 'budget_limit')).toBe(true);
  });
  it('certifies subject reads under the publication checkpoint too', async () => {
    const checkpoint = vi.fn(async () => ({
      status: 'unavailable' as const,
      reason: 'pending_publication',
    }));
    const reader = resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      publications: { checkpoint },
    });
    const result = await reader.resolveSubjects(['claim-1'], checkedContext());
    expect.soft(checkpoint).toHaveBeenCalled();
    expect.soft(result.issues.some((issue) => issue.reason === 'pending_publication')).toBe(true);
  });
  it('does not report a present mutable gloss as a historical value', async () => {
    const spy = vi.spyOn(subjectGraph, 'findClaimSubjects').mockResolvedValue([
      {
        entityId: 'entity',
        name: 'Entity',
        nameNorm: 'entity',
        sourceEpisodeId: 'episode-1',
        gloss: 'ONLY-WRITTEN-LATER',
      },
    ]);
    try {
      const result = await resolver({
        driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      }).resolveSubjects(
        ['claim-1'],
        checkedContext({
          mode: knewAt(new Date('2026-09-08T11:00:00.000Z')),
          now: new Date('2026-09-08T12:00:00.000Z'),
        }),
      );
      expect(result.results.get('["id","claim-1"]')?.value?.[0]?.gloss).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
  it('returns named unavailable results when the incidence store cannot be read', async () => {
    store.db.prepare('ALTER TABLE source_incidence RENAME TO source_incidence_probe_missing').run();
    try {
      const reader = resolver({ driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }) });
      const outcome = await reader
        .resolveMetadata(['claim-1'], checkedContext(), { maxRoots: 4 })
        .catch((error: unknown) => error);
      expect(outcome).toHaveProperty('results');
    } finally {
      store.db
        .prepare('ALTER TABLE source_incidence_probe_missing RENAME TO source_incidence')
        .run();
    }
  });

  it('does not include a later owning session in an earlier knowledge view', async () => {
    commitIncidence(store.db, {
      sourceId: 'episode-1',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'first-owner',
      at: NOW,
    });
    const later = new Date('2026-09-08T14:00:00.000Z');
    seedSource(store.db, {
      sourceId: 'episode-later',
      sessionId: 'later-session',
      identity: 'later-agent',
      content: { turns: [{ role: 'user', text: 'a later witness' }] },
      now: later,
    });
    commitIncidence(store.db, {
      sourceId: 'episode-later',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'later-owner',
      at: later,
    });
    establishScope(store.db, 'claim-1', durableRoleScope('extraction', 'out'), later);
    const result = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
    }).resolveMetadata(
      ['claim-1'],
      checkedContext({ mode: knewAt(new Date('2026-09-08T11:00:00.000Z')), now: later }),
      { maxRoots: 4 },
    );
    expect(result.results.get('["id","claim-1"]')?.value?.owningSessions).not.toContain(
      'later-session',
    );
  });
});
