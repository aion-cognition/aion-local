import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { curiosityLedgerKey, curiosityOperation, CURIOSITY_ASPECT } from './curiosity.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { CURIOSITY_ASKED_AT_PROPERTY } from '../../../infrastructure/graph/entity-description-queries.js';
import { linkEntityMentions } from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { INTENTION_ORIGIN_PROPERTY } from '../../../infrastructure/graph/intention-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import { VALID_HORIZON_PROPERTY } from '../../../infrastructure/graph/read-modes.js';
import { SYSTEM_SESSION_IDENTITY } from '../../../infrastructure/graph/sessions.js';
import {
  edgeTargetId,
  episodeIdsInSession,
  nodeProperties,
} from '../../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { getLedgerEntry } from '../../../infrastructure/sqlite/ops-ledger.js';
import { CueCache } from '../../../recall/application/cues.js';
import { handleRecall, type RecallDeps } from '../../../recall/application/recall.js';
import type { ReflectionIntakeDeps } from '../../../reflection/application/intake.js';
import { LaneAssigner } from '../../../reflection/application/lanes.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
} from '../../../reflection/domain/claim-key.js';
import { foldName } from '../../../reflection/domain/name-fold.js';
import { SessionManager } from '../../../session/session-manager.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * Curiosity end to end: the hole in the graph, the question filed against a system episode of
 * its own, and the recall that brings the question back because the entity it asks about turned
 * up again. The question episode goes through intake like any other experience, so this file
 * asserts on the ids it holds rather than on what the graph ended up containing.
 */

const EMBED_DIMENSION = 8;
const NOW = new Date('2026-09-05T12:00:00.000Z');
const RECALLED_AT = new Date('2026-09-05T13:00:00.000Z');

type SeedEntity = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
};

/** A gloss a correction retired: the entity says nothing at all about itself. */
const RETIRED: SeedEntity = {
  id: 'entity-ledger-rewrite',
  name: 'Ledger Rewrite',
  type: 'project',
};
/** Described once at its first mention and never since, while the mentions piled up. */
const NEVER_REDERIVED: SeedEntity = { id: 'entity-quillon', name: 'Quillon', type: 'concept' };
/** Described and barely mentioned: no hole for curiosity to see. */
const WELL_DESCRIBED: SeedEntity = { id: 'entity-sidecar', name: 'Sidecar', type: 'concept' };
/** Nothing on file and hardly mentioned: last in line rather than excluded. */
const QUIET: SeedEntity = { id: 'entity-kestrel', name: 'Kestrel', type: 'project' };

const BUSY_MENTIONS = 6;

const DRAFTED_QUESTION = 'What does the Ledger Rewrite actually cover, and who asked for it?';
const FALLBACK_QUESTION = 'What is Kestrel, and why does it keep coming up?';

type LedgerSummary = {
  readonly goalId: string;
  readonly episodeId: string;
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let memberId: string;
let workspaceId: string;
let intake: ReflectionIntakeDeps;

/**
 * Two orthogonal axes, questions on one and everything else on the other. A trigger is only
 * worth measuring where the query could not have found the intention on its own, and a question
 * that names the entity it is about shares every word a query about that entity carries. One
 * axis per kind of text is what keeps the vector leg from admitting the question and turning the
 * trigger into a second path to something the search already had.
 */
function vectors(texts: readonly string[]): Vector[] {
  return texts.map((text): Vector => {
    const axis = text.includes('?') ? 0 : 1;
    return Array.from({ length: EMBED_DIMENSION }, (_, slot) => (slot === axis ? 1 : 0));
  });
}

/** Answers the drafting prompt and embeds: the operation's only two calls. */
const draftingProvider: Provider = {
  embed: (texts) => Promise.resolve(vectors(texts)),
  generate: () => Promise.resolve({ question: DRAFTED_QUESTION }),
};

/** Embeds, and will not draft. The deterministic question is what a run gets from it. */
const muteProvider: Provider = {
  embed: (texts) => Promise.resolve(vectors(texts)),
  generate: () => Promise.reject(new Error('the drafting model is down')),
};

function config(overrides: Partial<Config['maintenance']> = {}): Config {
  return {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, embedDimension: EMBED_DIMENSION },
    maintenance: { ...DEFAULTS.maintenance, ...overrides },
  };
}

function context(
  provider: Provider,
  maintenance: Partial<Config['maintenance']> = {},
): OperationContext {
  return {
    driver: harness.driver,
    db,
    config: config(maintenance),
    logger,
    provider,
    intake,
    health: healthFixture(),
    now: NOW,
    signal: new AbortController().signal,
  };
}

function ledgerSummary(entityId: string): LedgerSummary {
  return getLedgerEntry(db, curiosityLedgerKey(entityId))?.summary as LedgerSummary;
}

async function seedEntity(
  entity: SeedEntity,
  input: { readonly text?: string; readonly mentions: number },
): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id: entity.id,
    now: NOW,
    occurredAt: NOW,
    properties: {
      name: entity.name,
      name_norm: foldName(entity.name),
      type: entity.type,
      ...(input.text === undefined ? {} : { text: input.text }),
    },
  });
  for (let index = 0; index < input.mentions; index += 1) {
    const episodeId = `${entity.id}-mention-${String(index)}`;
    await writeStampedNode(harness.driver, {
      label: 'Episode',
      id: episodeId,
      now: NOW,
      occurredAt: NOW,
      properties: {
        text: `a session that talked about ${entity.name} again`,
        session_id: 'session-mentions',
      },
    });
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [entity.id],
      now: NOW,
      confidence: 1,
      provenance: ['test-seed'],
    });
  }
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-curiosity-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Test User' });
  memberId = backbone.member.id;
  workspaceId = backbone.workspace.id;

  intake = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, { memberId, workspaceId }),
    provider: draftingProvider,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    acceptHookCapture: true,
  };

  await seedEntity(RETIRED, { mentions: BUSY_MENTIONS });
  await seedEntity(NEVER_REDERIVED, {
    text: 'a thing somebody mentioned once',
    mentions: BUSY_MENTIONS,
  });
  await seedEntity(WELL_DESCRIBED, { text: 'the helper process beside the main one', mentions: 2 });
  await seedEntity(QUIET, { mentions: 1 });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('curiosity against a live graph', () => {
  it('asks about the entities it cannot describe, the most mentioned ones first', async () => {
    const outcome = await curiosityOperation().run(context(draftingProvider));

    expect(outcome.status).toBe('applied');
    expect(outcome.itemsProcessed).toBe(2);
    expect(outcome.itemsAffected).toBe(2);

    const asked = await Promise.all(
      [RETIRED, NEVER_REDERIVED, WELL_DESCRIBED, QUIET].map(async (entity) => {
        const properties = await nodeProperties(harness.driver, entity.id);
        return properties[CURIOSITY_ASKED_AT_PROPERTY] !== undefined;
      }),
    );
    expect(asked).toEqual([true, true, false, false]);
  }, 120_000);

  it('stores the question as a standing intention of its own, keyed to the entity', async () => {
    const summary = ledgerSummary(RETIRED.id);
    expect(summary).toBeDefined();

    const goal = await nodeProperties(harness.driver, summary.goalId);
    expect(goal[MEMORY_PROPERTIES.text]).toBe(DRAFTED_QUESTION);
    expect(goal[INTENTION_ORIGIN_PROPERTY]).toBe('substrate');
    expect(goal[CLAIM_SUBJECT_PROPERTY]).toBe(RETIRED.id);
    expect(goal[CLAIM_ASPECT_PROPERTY]).toBe(CURIOSITY_ASPECT);
    // Dated forward from the run, so a question nobody answers ages out on its own.
    expect(goal[VALID_HORIZON_PROPERTY]).toBeDefined();
  }, 60_000);

  it('hangs the question off a real system episode rather than an id nothing wrote', async () => {
    const summary = ledgerSummary(RETIRED.id);

    expect(await edgeTargetId(harness.driver, 'EXTRACTED_FROM', summary.goalId)).toBe(
      summary.episodeId,
    );
    const episode = await nodeProperties(harness.driver, summary.episodeId);
    expect(episode[MEMORY_PROPERTIES.text]).toContain(DRAFTED_QUESTION);
    expect(episode[MEMORY_PROPERTIES.originEvent]).toBe('curiosity');
    expect(await episodeIdsInSession(harness.driver, SYSTEM_SESSION_IDENTITY)).toContain(
      summary.episodeId,
    );
  }, 60_000);

  it('brings the question back when the entity it asks about is in play again', async () => {
    const recall: RecallDeps = {
      driver: harness.driver,
      db,
      sessions: new SessionManager(harness.driver, { memberId, workspaceId }),
      provider: {
        embed: (texts) => Promise.resolve(vectors(texts)),
        generate: () =>
          Promise.resolve({ query_cues: [RETIRED.name], summary_cues: [], recent_turn_cues: [] }),
      },
      config: {
        ...config(),
        // The lexical leg is off for the same reason the vectors are split: the question
        // carries the entity's name, so bm25 would match it on the cue that names the entity
        // and the pack would hold it whether or not a trigger ever fired.
        search: { ...DEFAULTS.search, methods: ['vector', 'graph_traversal'] },
      },
      cueCache: new CueCache(),
      logger,
    };

    const pack = await handleRecall(
      recall,
      { query: `where did we land on ${RETIRED.name}` },
      { identity: 'curiosity-int-read-session', now: RECALLED_AT },
    );

    // The entity itself came back on the query; the question came back on the entity.
    expect(pack.facts?.map((item) => item.id)).toContain(RETIRED.id);
    const served = pack.intentions?.find((item) => item.content === DRAFTED_QUESTION);
    expect(served?.rationale.method).toBe('intention_trigger');
    expect(pack.rendered_text).toContain('## Intentions');
  }, 120_000);

  it('asks the deterministic question when the drafting model will not answer', async () => {
    const outcome = await curiosityOperation().run(context(muteProvider));

    expect(outcome.itemsAffected).toBe(1);
    const goal = await nodeProperties(harness.driver, ledgerSummary(QUIET.id).goalId);
    expect(goal[MEMORY_PROPERTIES.text]).toBe(FALLBACK_QUESTION);
  }, 120_000);

  it('never asks about one entity twice', async () => {
    const outcome = await curiosityOperation().run(context(draftingProvider));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'filed 0 question(s) over 0 candidate(s) the substrate cannot describe',
    });
  }, 60_000);

  it('does nothing at all with AION_MAINTENANCE_CURIOSITY off', async () => {
    const outcome = await curiosityOperation().run(context(draftingProvider, { curiosity: false }));

    expect(outcome).toEqual({
      status: 'noop',
      itemsProcessed: 0,
      itemsAffected: 0,
      detail: 'curiosity disabled by AION_MAINTENANCE_CURIOSITY; no entity examined',
    });
  }, 60_000);
});
