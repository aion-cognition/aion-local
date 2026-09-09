import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EvidenceResolver, type EvidenceCheckpointReader } from './resolver.js';
import { knewAt } from '../../infrastructure/graph/read-modes.js';
import * as subjectGraph from '../../infrastructure/graph/subject-family.js';
import type { CheckpointResult } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { idAddress } from '../domain/address.js';
import { EVIDENCE_LIMITS } from '../domain/budget.js';
import { durableRoleScope } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
  establishNodeState,
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

function failingDriver(): Driver {
  return {
    executeQuery: () => Promise.reject(new Error('graph unreachable')),
  } as unknown as Driver;
}

function checkpoints(results: readonly CheckpointResult[]): EvidenceCheckpointReader {
  let index = 0;
  return {
    checkpoint: () => {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return Promise.resolve(result!);
    },
  };
}

function ready(sequence: string, substrateId = 'substrate-1'): CheckpointResult {
  return {
    status: 'ready',
    checkpoint: {
      substrateId,
      protocolVersion: 1,
      sequence,
      operationId: null,
      intentDigest: null,
      resultDigest: null,
    },
  };
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
      turnIds: ['episode-1-turn'],
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

  it('reads a batch of candidates in bounded reads rather than one per candidate', async () => {
    const log: QueryLog = { cyphers: [] };
    const batch = await resolver({ driver: lineageDriver({ unresolved: 0, log }) }).resolveMetadata(
      ['claim-1', 'claim-2'],
      checkedContext(),
      { maxRoots: 4 },
    );

    expect(batch.results.size).toBe(2);
    expect(log.cyphers).toHaveLength(2);
    expect(log.cyphers.some((cypher) => cypher.includes('payload_json'))).toBe(false);
  });

  it('keeps a known incomplete lineage apart from a store that could not be read', async () => {
    const log: QueryLog = { cyphers: [] };
    const known = await resolver({ driver: lineageDriver({ unresolved: 1, log }) }).resolveMetadata(
      ['claim-1'],
      checkedContext(),
      { maxRoots: 4 },
    );
    const failed = await resolver({ driver: failingDriver() }).resolveMetadata(
      ['claim-1'],
      checkedContext(),
      { maxRoots: 4 },
    );
    const first = known.results.get('["id","claim-1"]');
    const second = failed.results.get('["id","claim-1"]');

    expect(first?.value?.provenance.complete).toBe(false);
    expect(first?.evidence.status).toBe('complete-for-use');
    expect(second?.evidence.status).toBe('unavailable-retryable');
    expect(second?.value).toBeUndefined();
  });

  it('gives every requested address a result, over the bound included', async () => {
    const log: QueryLog = { cyphers: [] };
    const wide = new EvidenceResolver({
      driver: lineageDriver({ unresolved: 0, log }),
      db: store.db,
      logger,
      limits: {
        requestedIds: 1,
        relationRows: 4096,
        metadataBytes: 1024,
        decodedRawBytes: 1024,
        checkpointAttempts: 2,
        lineageHops: 4,
      },
    });
    const batch = await wide.resolveMetadata(['claim-1', 'claim-2'], checkedContext(), {
      maxRoots: 4,
    });

    expect([...batch.results.keys()].sort()).toEqual(['["id","claim-1"]', '["id","claim-2"]']);
    expect(batch.issues.map((issue) => issue.reason)).toContain('budget_limit');
  });

  it('degrades a source read under a pending publication rather than blocking it', async () => {
    const batch = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      publications: checkpoints([{ status: 'unavailable', reason: 'pending_publication' }]),
    }).resolveSources([idAddress('episode-1')], checkedContext(), 'raw_inspection');
    const result = batch.results.get('["id","episode-1"]');

    expect(result?.value?.text).toContain('the migration took 45 seconds');
    expect(batch.issues.map((issue) => issue.reason)).toContain('pending_publication');
  });

  it('does not certify raw disclosure across a newly acknowledged forget', async () => {
    let calls = 0;
    const publications = {
      checkpoint: () => {
        calls += 1;
        if (calls === 2) {
          commitSourceState(store.db, {
            sourceId: 'episode-1',
            stateKind: 'forgotten',
            operationId: 'forget-during-read',
            at: NOW,
          });
        }
        return Promise.resolve(ready(String(calls)));
      },
    };
    const batch = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      publications,
    }).resolveSources([idAddress('episode-1')], checkedContext(), 'raw_inspection');

    expect(batch.results.get('["id","episode-1"]')?.evidence.status).not.toBe('complete-for-use');
  });

  it('does not certify the same sequence from a different substrate pairing', async () => {
    let calls = 0;
    const publications = {
      checkpoint: () => {
        calls += 1;
        return Promise.resolve(ready('1', calls === 1 ? 'first-substrate' : 'second-substrate'));
      },
    };
    const batch = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      publications,
    }).resolveSources([idAddress('episode-1')], checkedContext(), 'claim_judgment');

    expect(batch.results.get('["id","episode-1"]')?.evidence.status).not.toBe('complete-for-use');
  });

  it('keeps scope-store failure inside the per-address result contract', async () => {
    store.db.prepare('ALTER TABLE evidence_scope_versions RENAME TO hidden_scope_versions').run();
    try {
      const outcome = await resolver({
        driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      })
        .resolveMetadata(['claim-1'], checkedContext(), { maxRoots: 4 })
        .catch((error: unknown) => error);

      expect(outcome).not.toBeInstanceOf(Error);
      expect(outcome).toHaveProperty('results');
    } finally {
      store.db.prepare('ALTER TABLE hidden_scope_versions RENAME TO evidence_scope_versions').run();
    }
  });

  it('refuses to assemble a judgment whose reader cannot take a position', async () => {
    const assembly = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      // A composition that judges holds a reader. What is refused here is a reader that could
      // not take its position, which is the race the certification exists to detect; a
      // composition holding NO reader is a composition defect and not a per-call refusal.
      publications: checkpoints([{ status: 'unavailable', reason: 'pending_publication' }]),
    }).assembleJudgment(
      {
        route: 'claim_dedup',
        reservedUnits: 0,
        use: 'claim_judgment',
        sides: [
          { nodeId: 'claim-1', statement: 'one' },
          { nodeId: 'claim-2', statement: 'two' },
        ],
      },
      checkedContext(),
    );

    expect(assembly.status).toBe('incomplete');
    expect(
      assembly.status === 'incomplete' ? assembly.reasons.map((reason) => reason.reason) : [],
    ).toEqual(['pending_publication', 'pending_publication']);
  });

  it('refuses a judgment whose position moved while its evidence was read', async () => {
    commitIncidence(store.db, {
      sourceId: 'episode-1',
      nodeId: 'claim-1',
      role: 'extraction',
      operationId: 'extract:claim-1',
      at: NOW,
    });
    establishScope(store.db, 'claim-1', durableRoleScope('extraction', 'out'), NOW);
    establishScope(store.db, 'claim-1', durableRoleScope('stated_correction', 'in'), NOW);
    establishNodeState(store.db, 'claim-1', { revision: 1, at: NOW });
    const assembly = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      publications: checkpoints([ready('4'), ready('5')]),
    }).assembleJudgment(
      {
        route: 'claim_dedup',
        reservedUnits: 0,
        use: 'claim_judgment',
        sides: [
          { nodeId: 'claim-1', statement: 'one' },
          { nodeId: 'claim-1', statement: 'two' },
        ],
      },
      checkedContext(),
    );

    expect(assembly.status).toBe('incomplete');
    expect(
      assembly.status === 'incomplete' ? assembly.reasons.map((reason) => reason.reason) : [],
    ).toEqual(['pending_publication', 'pending_publication']);
  });

  it('refuses a stored revision once the source it cites has moved', async () => {
    const batch = await resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
    }).resolveSources([idAddress('episode-1')], checkedContext(), 'raw_inspection');

    expect(resolver({ driver: failingDriver() }).confirm(batch.revision)).toEqual({
      status: 'current',
    });

    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: NOW,
    });
    const check = resolver({ driver: failingDriver() }).confirm(batch.revision);

    expect(check.status).toBe('stale');
    expect(check.status === 'stale' ? check.changed.map((entry) => entry.scope) : []).toEqual([
      'source.state',
    ]);
  });

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
    const checkpoint = vi.fn(() =>
      Promise.resolve({ status: 'unavailable' as const, reason: 'pending_publication' }),
    );
    const reader = resolver({
      driver: lineageDriver({ unresolved: 0, log: { cyphers: [] } }),
      publications: { checkpoint },
    });
    const result = await reader.resolveSubjects(['claim-1'], checkedContext());

    expect(checkpoint).toHaveBeenCalled();
    expect(result.issues.some((issue) => issue.reason === 'pending_publication')).toBe(true);
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

  it('uses entity mention incidence for metadata ownership and sources', async () => {
    commitIncidence(store.db, {
      sourceId: 'episode-1',
      nodeId: 'entity',
      role: 'mention',
      operationId: 'entity-mention',
      at: NOW,
    });
    for (const role of ['extraction', 'mention', 'participation'] as const) {
      establishScope(
        store.db,
        'entity',
        durableRoleScope(role, role === 'extraction' ? 'out' : 'in'),
        NOW,
      );
    }
    const entityGraph = {
      executeQuery: () =>
        Promise.resolve({ records: [{ toObject: () => ({ id: 'entity', capture_ids: [] }) }] }),
    } as unknown as Driver;
    const result = await resolver({ driver: entityGraph }).resolveMetadata(
      ['entity'],
      checkedContext(),
      { maxRoots: 4 },
    );
    const value = result.results.get('["id","entity"]')?.value;

    expect(value?.owningSessions).toEqual(['session-1']);
    expect(value?.sources).toEqual(['episode-1']);
    // Ownership is not lineage: a mentioning source is not an independent root.
    expect(value?.provenance.roots).toEqual([]);
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
      turnIds: ['episode-later-turn'],
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
