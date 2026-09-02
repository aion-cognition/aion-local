import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SupersessionStage } from './supersession.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../../infrastructure/graph/backbone.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../../infrastructure/graph/cognitive-queries.js';
import { linkEntityMentions, mergeEntities } from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import { testGenerationProvider } from '../../../infrastructure/providers/test-support/generation-provider.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { listSupersessionProposals } from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';

/**
 * The residue boundary, asserted rather than described: which claims the key takes off the
 * judge's hands and which it does not.
 *
 * The rule is that a keyed close removes a pair, never a claim. A claim whose key matched
 * nothing is still judged through the legs that have always found it, and in `judge` mode a
 * keyed match is a candidate the same two passes decide. Nothing anywhere filters on whether a
 * claim carries a key.
 *
 * The judge is stubbed on purpose. What is under test is which pairs reach it and how they were
 * reached, and a live answer would make the routing claim depend on a model agreeing with it.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');

const SESSION_ID = 'keyed-residue';

/** The subject both halves of the matched pair assert about, keyed by id rather than by name. */
const KEYED_SUBJECT = 'quillon ingest';

const KEYED_ASPECT = 'retry limit';

/** The subject the unmatched claim names in words, which is how the fallback leg reaches it. */
const NAMED_SUBJECT = 'solstice scheduler';

const CLAIMS = {
  keyedPrior: 'The Quillon ingest retry limit is three attempts.',
  keyedNext: 'The Quillon ingest retry limit is now seven attempts.',
  unkeyedPrior: 'The Solstice scheduler runs its sweep every fifteen minutes.',
  unmatchedNext: 'The Solstice scheduler sweep now runs every four hours.',
} as const;

type Seeded = {
  readonly keyedPriorId: string;
  readonly keyedNextId: string;
  readonly keyedEpisodeId: string;
  readonly unkeyedPriorId: string;
  readonly unmatchedEpisodeId: string;
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let seeded: Seeded;

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt: NOW,
    properties: { text: id, session_id: SESSION_ID },
  });
}

async function seedEntity(name: string, episodeId: string): Promise<string> {
  const [entity] = await mergeEntities(
    harness.driver,
    [
      {
        name,
        nameNorm: name,
        type: 'project',
        text: `${name} (project)`,
        sourceEpisodeId: episodeId,
        extractionMethod: 'keyed-residue-seed',
        confidence: 1,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  if (entity === undefined) {
    throw new Error(`the fixture failed to seed the entity ${name}`);
  }
  return entity.id;
}

/** Answers every judgment the same way, so which pairs arrive is the only variable. */
function stubProvider(calls: StructuredRequest[]): Provider {
  return {
    embed: async () => [],
    generate: async (request: StructuredRequest) => {
      calls.push(request);
      return { contradicts: true, confidence: 0.9, rationale: 'the later statement reverses it' };
    },
  };
}

function contextFor(episodeId: string, provider: Provider): StageContext {
  return {
    driver: harness.driver,
    db,
    provider,
    episodeId,
    episode: { id: episodeId, sessionId: SESSION_ID, text: episodeId, turns: [] },
    logger: openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' }),
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-keyed-residue-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DEFAULTS.models.embedDimension });
  await bootstrapBackbone(harness.driver, { memberName: 'Test User' });

  const episodes = ['keyed-prior', 'keyed-next', 'unkeyed-prior', 'unmatched-next'];
  for (const id of episodes) {
    await seedEpisode(id);
  }

  const keyedSubjectId = await seedEntity(KEYED_SUBJECT, 'keyed-prior');
  const namedSubjectId = await seedEntity(NAMED_SUBJECT, 'unkeyed-prior');
  // Only the fallback leg's episodes mention an entity. The keyed pair is reachable by its key
  // and by nothing else, so a candidate there names the leg that found it.
  for (const episodeId of ['unkeyed-prior', 'unmatched-next']) {
    await linkEntityMentions(harness.driver, {
      episodeId,
      entityIds: [namedSubjectId],
      now: NOW,
      confidence: 1,
      provenance: ['keyed-residue-seed'],
    });
  }

  const provider = testGenerationProvider({
    baseUrl: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    embedModel: DEFAULTS.models.embed,
  });
  const vectors = await provider.embed([
    CLAIMS.keyedPrior,
    CLAIMS.keyedNext,
    CLAIMS.unkeyedPrior,
    CLAIMS.unmatchedNext,
  ]);

  const keyedPrior = await writeCognitiveNode(harness.driver, {
    episodeId: 'keyed-prior',
    label: 'Concept',
    text: CLAIMS.keyedPrior,
    contentVector: vectors[0],
    occurredAt: NOW,
    now: NOW,
    subjectEntityId: keyedSubjectId,
    aspectNorm: KEYED_ASPECT,
  });
  const keyedNext = await writeCognitiveNode(harness.driver, {
    episodeId: 'keyed-next',
    label: 'Decision',
    text: CLAIMS.keyedNext,
    contentVector: vectors[1],
    occurredAt: NOW,
    now: NOW,
    subjectEntityId: keyedSubjectId,
    aspectNorm: KEYED_ASPECT,
  });
  const unkeyedPrior = await writeCognitiveNode(harness.driver, {
    episodeId: 'unkeyed-prior',
    label: 'Concept',
    text: CLAIMS.unkeyedPrior,
    contentVector: vectors[2],
    occurredAt: NOW,
    now: NOW,
  });
  // A key that names a real subject and an attribute nothing else asserts: the lookup runs and
  // comes back empty, which is the case the boundary rule is about.
  await writeCognitiveNode(harness.driver, {
    episodeId: 'unmatched-next',
    label: 'Decision',
    text: CLAIMS.unmatchedNext,
    contentVector: vectors[3],
    occurredAt: NOW,
    now: NOW,
    subjectEntityId: namedSubjectId,
    aspectNorm: 'sweep cadence',
  });

  seeded = {
    keyedPriorId: keyedPrior.node.id,
    keyedNextId: keyedNext.node.id,
    keyedEpisodeId: 'keyed-next',
    unkeyedPriorId: unkeyedPrior.node.id,
    unmatchedEpisodeId: 'unmatched-next',
  };
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the residue boundary around a claim key', () => {
  it('sends a keyed match to the judge as a candidate, naming the subject both claims key on', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await new SupersessionStage({
      mode: 'propose',
      keyedCloseMode: 'judge',
      maxNeighbors: 1,
    }).run(contextFor(seeded.keyedEpisodeId, stubProvider(calls)));

    expect(outcome.status).toBe('ok');
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain(CLAIMS.keyedPrior);
    expect(prompt).toContain(CLAIMS.keyedNext);
    // The key carries the subject's own name through, so the judge is told what both statements
    // are about without a substring of either one having established it.
    expect(prompt).toContain(`Both statements name: ${KEYED_SUBJECT}`);

    // `propose` mode, so the judge's answer is a row and never a close: the keyed candidate is
    // decided by the same two passes as any other, and by nothing on the way in.
    expect(outcome.counts?.supersessions).toBe(0);
    expect(
      listSupersessionProposals(db).find((row) => row.oldId === seeded.keyedPriorId),
    ).toMatchObject({ newId: seeded.keyedNextId, episodeId: seeded.keyedEpisodeId });
  }, 120_000);

  it('leaves the same pair to the unkeyed legs when the keyed close is switched off', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await new SupersessionStage({
      mode: 'propose',
      keyedCloseMode: 'off',
      maxNeighbors: 1,
      // Nothing scores a full cosine against a different sentence, so the widener is closed and
      // the keyed episode mentions no entity. What is left is the leg under test.
      neighborThreshold: 1,
    }).run(contextFor(seeded.keyedEpisodeId, stubProvider(calls)));

    expect(outcome.status).toBe('ok');
    expect(calls).toEqual([]);
  }, 120_000);

  it('still judges a keyed claim whose key matched nothing', async () => {
    const calls: StructuredRequest[] = [];
    const outcome = await new SupersessionStage({
      mode: 'propose',
      keyedCloseMode: 'judge',
      maxNeighbors: 1,
    }).run(contextFor(seeded.unmatchedEpisodeId, stubProvider(calls)));

    expect(outcome.status).toBe('ok');
    // The key found no mate, so the claim fell through to the subject leg that has always
    // handled it. A claim is never taken out of the pool for carrying a key.
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.messages.map((message) => message.content).join('\n');
    expect(prompt).toContain(CLAIMS.unkeyedPrior);
    expect(prompt).toContain(`Both statements name: ${NAMED_SUBJECT}`);
    expect(listSupersessionProposals(db).some((row) => row.oldId === seeded.unkeyedPriorId)).toBe(
      true,
    );
  }, 120_000);
});
