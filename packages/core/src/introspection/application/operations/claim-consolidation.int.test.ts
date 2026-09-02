import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimConsolidationOperation } from './claim-consolidation.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import {
  BITEMPORAL_PROPERTIES,
  supersede,
  writeStampedNode,
} from '../../../infrastructure/graph/bitemporal.js';
import { CONSOLIDATION_EXTRACTION_METHOD } from '../../../infrastructure/graph/claim-consolidation-queries.js';
import { COMMUNITY_PROPERTY } from '../../../infrastructure/graph/community-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { EXTRACTION_TYPE } from '../../../infrastructure/graph/labels.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
} from '../../../infrastructure/graph/narrative-queries.js';
import {
  countEdges,
  nodeLabels,
  nodeProperties,
  supersedingNodeIds,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { consolidationVetoKey } from '../../../reflection/application/claim-consolidation.js';
import { consolidationNodeId } from '../../../reflection/domain/consolidation.js';
import { coverageKey } from '../../../reflection/domain/narrative.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * One dense neighbourhood spanning two sessions, and two thin ones beside it so the run has a
 * distribution to derive its floor from. Real Neo4j because everything at stake is a graph
 * fact: which claims a community holds, how many sessions they came from, whether the member set
 * has been consolidated before, and what the close does to the members.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-04-08T09:00:00.000Z');

const REVIEW_MARKER = 'You review a draft memory';

const DENSE_COMMUNITY = 7;

let harness: Neo4jHarness;
let db: SqliteHandle;
let logger: Logger;
let dataDir: string;

type ClaimSeed = {
  readonly id: string;
  readonly label: 'Decision' | 'Insight';
  readonly episodeId: string;
  readonly community: number;
  readonly at: string;
  readonly text: string;
};

const SESSIONS = ['consolidation-session-a', 'consolidation-session-b'];

const CLAIMS: readonly ClaimSeed[] = [
  {
    id: 'claim-retry-1',
    label: 'Decision',
    episodeId: 'consolidation-ep-a',
    community: DENSE_COMMUNITY,
    at: '2026-04-06T09:00:00.000Z',
    text: 'The worker retries a failed enrichment three times before the job is dead-lettered.',
  },
  {
    id: 'claim-retry-2',
    label: 'Insight',
    episodeId: 'consolidation-ep-a',
    community: DENSE_COMMUNITY,
    at: '2026-04-06T09:10:00.000Z',
    text: 'Retry backoff doubles from two seconds and is capped at one minute per attempt.',
  },
  {
    id: 'claim-retry-3',
    label: 'Decision',
    episodeId: 'consolidation-ep-b',
    community: DENSE_COMMUNITY,
    at: '2026-04-07T09:00:00.000Z',
    text: 'A dead-lettered job is reopened by hand and never retried automatically after that.',
  },
  {
    id: 'claim-retry-4',
    label: 'Insight',
    episodeId: 'consolidation-ep-b',
    community: DENSE_COMMUNITY,
    at: '2026-04-07T09:20:00.000Z',
    text: 'The breaker counts consecutive worker failures rather than failures inside a window.',
  },
  {
    id: 'claim-unrelated-1',
    label: 'Decision',
    episodeId: 'consolidation-ep-a',
    community: 8,
    at: '2026-04-06T10:00:00.000Z',
    text: 'The pack renders narratives ahead of preferences.',
  },
  {
    id: 'claim-unrelated-2',
    label: 'Insight',
    episodeId: 'consolidation-ep-b',
    community: 9,
    at: '2026-04-07T10:00:00.000Z',
    text: 'Recall reads the entity name index before the vector index.',
  },
];

const MEMBER_IDS = CLAIMS.filter((claim) => claim.community === DENSE_COMMUNITY).map(
  (claim) => claim.id,
);

const CONSOLIDATION_ID = consolidationNodeId(coverageKey(MEMBER_IDS));

function stubProvider(verdict: 'unanimous' | 'vetoed'): Provider {
  return {
    embed: (texts) =>
      Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIMENSION }, () => 0.5))),
    generate: (request) => {
      const prompt = request.messages.map((message) => message.content).join('\n');
      if (prompt.includes(REVIEW_MARKER)) {
        return Promise.resolve(
          verdict === 'vetoed'
            ? { unsupported: true, reason: 'sentence 1 states a cause the claims do not' }
            : { unsupported: false, reason: 'every sentence stays inside its citations' },
        );
      }
      const handles = [...new Set(prompt.match(/\[S\d+\]/g) ?? [])].map((tag) => tag.slice(1, -1));
      return Promise.resolve({
        sentences: [
          {
            text: 'Worker retries are bounded and dead letters are reopened by hand.',
            source_ids: handles,
          },
        ],
      });
    },
  };
}

function configWith(armed: boolean): Config {
  return {
    ...DEFAULTS,
    maintenance: { ...DEFAULTS.maintenance, claimConsolidation: armed },
  };
}

function context(
  config: Config = configWith(true),
  verdict: 'unanimous' | 'vetoed' = 'unanimous',
): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider: stubProvider(verdict),
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

async function seedClaim(claim: ClaimSeed): Promise<void> {
  const at = new Date(claim.at);
  await writeStampedNode(harness.driver, {
    label: claim.label,
    id: claim.id,
    now: at,
    occurredAt: at,
    properties: { [MEMORY_PROPERTIES.text]: claim.text },
  });
  await upsertEdge(harness.driver, {
    type: EXTRACTION_TYPE,
    sourceId: claim.id,
    targetId: claim.episodeId,
    strength: 1,
    confidence: 1,
    signals: ['extraction'],
    provenance: ['test'],
    count: 0,
    now: at,
  });
}

/** The projection's own write, stood in for: `community_refresh` stamps this property. */
async function assignCommunities(): Promise<void> {
  for (const claim of CLAIMS) {
    await writeStampedNode(harness.driver, {
      label: claim.label,
      id: claim.id,
      now: new Date(claim.at),
      mergeProperties: { [COMMUNITY_PROPERTY]: claim.community },
    });
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-consolidation-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'error' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  for (const [index, sessionId] of SESSIONS.entries()) {
    const episodeId = index === 0 ? 'consolidation-ep-a' : 'consolidation-ep-b';
    await writeStampedNode(harness.driver, { label: 'Session', id: sessionId, now: NOW });
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: episodeId,
      now: NOW,
      occurredAt: NOW,
      properties: { [MEMORY_PROPERTIES.text]: `body of ${episodeId}` },
    });
    await upsertEdge(harness.driver, {
      type: CONTAINMENT_TYPE,
      sourceId: episodeId,
      targetId: sessionId,
      strength: 1,
      confidence: 1,
      signals: ['episodic'],
      provenance: ['test'],
      count: 0,
      now: NOW,
    });
  }

  for (const claim of CLAIMS) {
    await seedClaim(claim);
  }
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('claim consolidation against a live substrate', () => {
  it('examines no subject while the kill switch is off', async () => {
    const outcome = await claimConsolidationOperation().run(context(configWith(false)));

    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain('AION_MAINTENANCE_CLAIM_CONSOLIDATION');
  });

  it('derives no floor at all while no claim carries a community', async () => {
    const outcome = await claimConsolidationOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.itemsProcessed).toBe(0);
    expect(outcome.detail).toBe(
      'no claim carries a community assignment, so no density floor can be derived',
    );
  });

  it('writes nothing when the review vetoes the synthesis, and does not ask again', async () => {
    await assignCommunities();

    const outcome = await claimConsolidationOperation().run(context(configWith(true), 'vetoed'));

    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain('1 vetoed by review');
    for (const memberId of MEMBER_IDS) {
      const properties = await nodeProperties(harness.driver, memberId);
      expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    }

    // The refusal is recorded against this exact member set, so the next tick spends its two
    // model calls somewhere it can still compress rather than on the same answer.
    const second = await claimConsolidationOperation().run(context(configWith(true), 'vetoed'));
    expect(second.detail).toContain('0 vetoed by review');
    expect(second.detail).toContain('1 already covered');

    // Cleared here so the tests below measure the ordinary path rather than this refusal.
    db.prepare('DELETE FROM ops_ledger WHERE key = ?').run(
      consolidationVetoKey(coverageKey(MEMBER_IDS)),
    );
  });

  it('reads its density floor off the neighbourhoods the substrate actually holds', async () => {
    const outcome = await claimConsolidationOperation().run(context());

    expect(outcome.status).toBe('applied');
    expect(outcome.detail).toContain('density floor 4 derived from 3 neighbourhood(s)');
    expect(outcome.itemsProcessed).toBe(1);
    expect(outcome.itemsAffected).toBe(1);
  });

  it('grounds every sentence, spans a DERIVES_FROM edge to each source, and closes them', async () => {
    expect(await nodeLabels(harness.driver, CONSOLIDATION_ID)).toEqual([
      'AionNode',
      'Insight',
      'Memory',
    ]);

    const properties = await nodeProperties(harness.driver, CONSOLIDATION_ID);
    expect(properties[MEMORY_PROPERTIES.extractionMethod]).toBe(CONSOLIDATION_EXTRACTION_METHOD);
    expect(properties[NARRATIVE_PROPERTIES.coverageCount]).toBe(MEMBER_IDS.length);
    expect(properties[NARRATIVE_PROPERTIES.citations]).toEqual(MEMBER_IDS);
    expect(Number(properties[NARRATIVE_PROPERTIES.sentenceCount])).toBeGreaterThan(0);
    expect(properties[MEMORY_PROPERTIES.contentVector]).toHaveLength(EMBED_DIMENSION);

    for (const memberId of MEMBER_IDS) {
      expect(await countEdges(harness.driver, DERIVES_FROM_TYPE, CONSOLIDATION_ID, memberId)).toBe(
        1,
      );
      expect(await supersedingNodeIds(harness.driver, memberId)).toEqual([CONSOLIDATION_ID]);
      expect(
        (await nodeProperties(harness.driver, memberId))[BITEMPORAL_PROPERTIES.validUntil],
      ).toBeInstanceOf(Date);
    }
  });

  it('leaves the unrelated neighbourhoods alone', async () => {
    for (const claim of CLAIMS.filter((seed) => seed.community !== DENSE_COMMUNITY)) {
      const properties = await nodeProperties(harness.driver, claim.id);
      expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    }
  });

  it('synthesizes nothing a second time over a member set that has not changed', async () => {
    for (const memberId of MEMBER_IDS) {
      await unsupersedeNode(harness.driver, { id: memberId, now: NOW });
    }

    const outcome = await claimConsolidationOperation().run(context());

    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain('1 already covered');
    for (const memberId of MEMBER_IDS) {
      // Closed again by the standing consolidation rather than by a second one.
      expect(await supersedingNodeIds(harness.driver, memberId)).toEqual([CONSOLIDATION_ID]);
      expect(
        (await nodeProperties(harness.driver, memberId))[BITEMPORAL_PROPERTIES.validUntil],
      ).toBeInstanceOf(Date);
    }
  });
  it('writes nothing when a correction closes a member while the synthesis runs', async () => {
    const community = 12;
    const seeds: readonly ClaimSeed[] = [
      {
        id: 'claim-lag-1',
        label: 'Decision',
        episodeId: 'consolidation-ep-a',
        community,
        at: '2026-04-06T11:00:00.000Z',
        text: 'Queue lag is sampled once a minute and kept for a day.',
      },
      {
        id: 'claim-lag-2',
        label: 'Insight',
        episodeId: 'consolidation-ep-a',
        community,
        at: '2026-04-06T11:10:00.000Z',
        text: 'The oldest unclaimed job is what the lag gauge reports.',
      },
      {
        id: 'claim-lag-3',
        label: 'Decision',
        episodeId: 'consolidation-ep-b',
        community,
        at: '2026-04-07T11:00:00.000Z',
        text: 'A lag sample older than a day is dropped rather than aggregated.',
      },
      {
        id: 'claim-lag-4',
        label: 'Insight',
        episodeId: 'consolidation-ep-b',
        community,
        at: '2026-04-07T11:20:00.000Z',
        text: 'Lag is reported per lane, because the interactive lane is served first.',
      },
    ];
    for (const seed of seeds) {
      await seedClaim(seed);
      await writeStampedNode(harness.driver, {
        label: seed.label,
        id: seed.id,
        now: new Date(seed.at),
        mergeProperties: { [COMMUNITY_PROPERTY]: seed.community },
      });
    }

    // A correction lands between the member read and the write, which is the window two model
    // calls hold open.
    const corrected = seeds[0]!.id;
    const correcting: Provider = {
      embed: (texts) =>
        Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIMENSION }, () => 0.5))),
      generate: async (request) => {
        await supersede(harness.driver, {
          oldId: corrected,
          newId: MEMBER_IDS[0]!,
          now: NOW,
          validUntil: NOW,
          signals: ['contradiction'],
          provenance: ['test'],
        });
        return stubProvider('unanimous').generate(request);
      },
    };

    const outcome = await claimConsolidationOperation().run({
      ...context(),
      provider: correcting,
    });

    expect(outcome.status).toBe('noop');
    expect(outcome.detail).toContain('1 corrected under the synthesis');
    // Nothing absorbed the neighbourhood, so the three claims that still stand keep standing.
    for (const seed of seeds.slice(1)) {
      expect(await supersedingNodeIds(harness.driver, seed.id)).toEqual([]);
    }
  });
});
