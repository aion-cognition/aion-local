import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { claimDedupOperation } from './claim-dedup.js';
import { CoveredJudgmentEvidence } from '../../../evidence/application/covered-judgment.js';
import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import {
  commitIncidence,
  establishNodeState,
  establishScope,
  seedSource,
} from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  countOutgoingEdges,
  nodeProperties,
  supersessionEdge,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { previewSupersession, unsupersedeNode } from '../../../infrastructure/graph/unsupersede.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { claimMergePublication } from '../../../reflection/application/merge-publication.js';
import { claimDedupPairKey } from '../../domain/claim-dedup.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Two vector clusters, orthogonal to each other, so a nearest-neighbor search never crosses
 * between the near-duplicate pair and the merely-related one: each pair's own cosine clears
 * the floor, and the two pairs read as unrelated to each other.
 */
const EMBED_DIMENSION = 8;
const NEAR_DUP_A = [1, 0, 0, 0, 0, 0, 0, 0];
const NEAR_DUP_B = [0.98, 0.05, 0, 0, 0, 0, 0, 0];
const RELATED_A = [0, 0, 1, 0, 0, 0, 0, 0];
const RELATED_B = [0, 0, 0.98, 0.05, 0, 0, 0, 0];

const NOW = new Date('2026-08-31T13:00:00.000Z');
const minutesAgo = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let coordinator: PublicationCoordinator;
let evidence: CoveredJudgmentEvidence;

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text: `episode ${id}`, session_id: 'session-1' },
  });
}

async function seedClaim(input: {
  readonly episodeId: string;
  readonly text: string;
  readonly vector: readonly number[];
  readonly occurredAt: Date;
}): Promise<string> {
  await seedEpisode(input.episodeId);
  // The durable half of the same claim. A merge is judged through the composed evidence seam and
  // published under the coordinator, so the records that seam reads have to exist: a graph node
  // with no source record behind it is a claim nothing can be certified about.
  seedSource(db, {
    sourceId: input.episodeId,
    sessionId: 'session-1',
    identity: 'review',
    content: { observations: [input.text] },
    now: NOW,
  });
  establishScope(db, input.episodeId, 'source.state', NOW);
  establishScope(db, input.episodeId, 'sqlite:mention:out', NOW);
  const result = await writeCognitiveNode(harness.driver, {
    episodeId: input.episodeId,
    label: 'Concept',
    text: input.text,
    contentVector: input.vector,
    occurredAt: input.occurredAt,
    now: NOW,
  });
  const nodeId = result.node.id;
  commitIncidence(db, {
    sourceId: input.episodeId,
    nodeId,
    role: 'extraction',
    operationId: `extract-${input.episodeId}`,
    at: NOW,
  });
  establishScope(db, nodeId, 'sqlite:extraction:out', NOW);
  establishScope(db, nodeId, 'sqlite:stated_correction:in', NOW);
  establishNodeState(db, nodeId, { revision: 1, at: NOW });
  return nodeId;
}

/** Sequential canned answers, so a test controls exactly what each judge call decides. */
function scriptedProvider(...answers: unknown[]): Provider {
  let call = 0;
  return {
    embed: () => Promise.reject(new Error('claim dedup must never embed')),
    generate: () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return Promise.resolve(answer);
    },
  };
}

function contextFor(provider: Provider, config: Config = DEFAULTS): OperationContext {
  return {
    driver: harness.driver,
    db,
    config,
    logger,
    provider,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
    publications: coordinator,
    evidence,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-dedup-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...PUBLICATION_HANDLERS, claimMergePublication],
  });
  await coordinator.initialize();
  evidence = new CoveredJudgmentEvidence({
    db,
    resolver: new EvidenceResolver({
      driver: harness.driver,
      db,
      logger,
      publications: coordinator,
    }),
    now: () => NOW,
  });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('claimDedupOperation against a live graph', () => {
  it('merges the near-duplicate pair, leaves the merely-related pair queued as related, and the undo round-trips', async () => {
    // Newest first, so the operation's recency scan visits the related pair's newer claim,
    // then the near-dup pair's newer claim, in that order: two judge calls for the related
    // pair's detection alone (same:false stops there), then detection plus review for the
    // near-dup pair (same:true, then unanimous).
    const relatedOlderId = await seedClaim({
      episodeId: 'ep-related-old',
      text: 'the checkout service reads from the primary replica',
      vector: RELATED_A,
      occurredAt: minutesAgo(30),
    });
    const relatedNewerId = await seedClaim({
      episodeId: 'ep-related-new',
      text: 'the checkout service falls back to a read replica under load',
      vector: RELATED_B,
      occurredAt: minutesAgo(5),
    });
    const survivorId = await seedClaim({
      episodeId: 'ep-dup-old',
      text: 'we use Postgres for the ledger store',
      vector: NEAR_DUP_A,
      occurredAt: minutesAgo(40),
    });
    const loserId = await seedClaim({
      episodeId: 'ep-dup-new',
      text: 'the ledger store runs on Postgres',
      vector: NEAR_DUP_B,
      occurredAt: minutesAgo(10),
    });

    const provider = scriptedProvider(
      { same: false, rationale: 'one names a fallback, the other the steady state' },
      { same: true, rationale: 'both assert the same storage choice' },
      { either_adds_information: false, reason: 'no fact, scope, or qualifier differs' },
    );

    const outcome = await claimDedupOperation().run(contextFor(provider));

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(outcome.itemsAffected).toBe(1);
    expect(outcome.detail).toBe(
      '2 pair(s) judged: 1 merged, 1 related, 0 vetoed, 0 stale, 0 failed',
    );

    // The related pair: both sides stay current, and the pair is ledgered so a later run
    // never spends a judge call on it again.
    expect((await nodeProperties(harness.driver, relatedOlderId)).valid_until).toBeUndefined();
    expect((await nodeProperties(harness.driver, relatedNewerId)).valid_until).toBeUndefined();
    const relatedEntry = getLedgerEntry(db, claimDedupPairKey(relatedOlderId, relatedNewerId));
    expect(relatedEntry?.summary).toMatchObject({ verdict: 'related' });

    // The near-dup pair: the older claim survives current, the newer closes with lineage.
    expect((await nodeProperties(harness.driver, survivorId)).valid_until).toBeUndefined();
    const preUndoLoser = await nodeProperties(harness.driver, loserId);
    expect(preUndoLoser.valid_until).toBeDefined();
    const edge = await supersessionEdge(harness.driver, loserId);
    expect(edge?.sourceId).toBe(survivorId);
    expect(edge?.signals).toEqual(['claim_dedup']);
    expect(edge?.provenance).toEqual(['claim_dedup']);

    // Provenance folded forward: the survivor now reaches both source episodes.
    expect(await countOutgoingEdges(harness.driver, 'EXTRACTED_FROM', survivorId)).toBe(2);
    // The loser's own edge to its origin episode was never touched, redirected, or removed.
    expect(await countOutgoingEdges(harness.driver, 'EXTRACTED_FROM', loserId)).toBe(1);

    const mergedEntry = getLedgerEntry(db, claimDedupPairKey(survivorId, loserId));
    expect(mergedEntry?.summary).toMatchObject({ verdict: 'merged', survivorId, loserId });

    // A second run costs nothing further: both pairs are permanently settled.
    const second = await claimDedupOperation().run(contextFor(scriptedProvider({ same: false })));
    expect(second.status).toBe('noop');
    expect(second.itemsProcessed).toBe(0);

    // The undo, driven entirely by the lineage the merge wrote: `aion unsupersede`'s own
    // machinery, with no claim-specific undo of its own.
    const preview = await previewSupersession(harness.driver, loserId);
    expect(preview?.closed).toBe(true);
    expect(preview?.lineage).toEqual([{ supersededBy: survivorId, provenance: ['claim_dedup'] }]);

    const reopened = await unsupersedeNode(harness.driver, { id: loserId, now: NOW });
    expect(reopened.justReopened).toBe(true);

    const postUndoLoser = await nodeProperties(harness.driver, loserId);
    expect(postUndoLoser.valid_until).toBeUndefined();
    expect(postUndoLoser.tx_until).toBeUndefined();
    expect((await nodeProperties(harness.driver, survivorId)).valid_until).toBeUndefined();

    // Restored, not merely reopened: the loser's own provenance edge is exactly what it was
    // before the merge, since nothing was ever redirected off it.
    expect(await countOutgoingEdges(harness.driver, 'EXTRACTED_FROM', loserId)).toBe(1);
    // The survivor's folded edge is additive and stands independent of the undo: it was true
    // before the merge (the survivor's text was also asserted by the loser's episode) and
    // stays true after.
    expect(await countOutgoingEdges(harness.driver, 'EXTRACTED_FROM', survivorId)).toBe(2);
  }, 120_000);

  it('does nothing with AION_MAINTENANCE_CLAIM_DEDUP off', async () => {
    const idA = await seedClaim({
      episodeId: 'ep-off-a',
      text: 'the export job runs nightly',
      vector: [0, 0, 0, 0, 1, 0, 0, 0],
      occurredAt: minutesAgo(20),
    });
    const idB = await seedClaim({
      episodeId: 'ep-off-b',
      text: 'the nightly export job runs once a day',
      vector: [0, 0, 0, 0, 0.98, 0.05, 0, 0],
      occurredAt: minutesAgo(2),
    });
    const disabled: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, claimDedup: false },
    };

    const outcome = await claimDedupOperation().run(
      contextFor(scriptedProvider({ same: true }), disabled),
    );

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'claim dedup disabled by AION_MAINTENANCE_CLAIM_DEDUP; no claims examined',
    });
    expect((await nodeProperties(harness.driver, idA)).valid_until).toBeUndefined();
    expect((await nodeProperties(harness.driver, idB)).valid_until).toBeUndefined();
  }, 120_000);
});
