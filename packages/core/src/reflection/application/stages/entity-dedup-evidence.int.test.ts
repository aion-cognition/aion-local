import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EntityDedupStage } from './entity-dedup.js';
import { CoveredJudgmentEvidence } from '../../../evidence/application/covered-judgment.js';
import type { JudgmentEvidence } from '../../../evidence/application/judgment.js';
import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { idAddress } from '../../../evidence/domain/address.js';
import {
  establishEntityEvidence,
  seedEntitySource,
  stopCapture,
} from '../../../evidence/test-support/entity-evidence.fixture.js';
import { commitSourceState } from '../../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { writeStampedNode } from '../../../infrastructure/graph/bitemporal.js';
import {
  linkEntityMentions,
  mergeEntities,
  writeEntityVectors,
} from '../../../infrastructure/graph/entity-queries.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../../infrastructure/publication/handlers.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { openSqliteHandle, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import { listEntityMergeProposals } from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { scriptedEntityJudge, type ScriptedEntityJudge } from '../entity-merge-judge.fixture.js';
import type { ReflectionRun } from '../orchestrator.js';
import { ReflectionOrchestrator } from '../orchestrator.js';

/**
 * An entity pair whose sources are long hook captures, judged through the evidence seam the
 * service composes: the resolver, the publication coordinator, and a coverage check per pair.
 *
 * Read whole, the subject's captures alone exceed the pair's 256 KiB decode allowance, which is
 * the history that used to withhold every such pair and fail the reflection job that owed it. The
 * first run here stands in for that build; the second is the same job retried on this one.
 */

const DIMENSION = DEFAULTS.models.embedDimension;
const NOW = new Date('2026-09-28T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let coordinator: PublicationCoordinator;
let evidence: CoveredJudgmentEvidence;

function nearVector(axis: number, lean = 0): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[axis] = 1;
  vector[axis + 1] = lean;
  return vector;
}

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

/**
 * Two near-duplicate entities, the episode being reflected on that mentions the subject, and in
 * SQLite the long captures behind the subject and one short one behind the candidate.
 */
async function seedPair(input: {
  readonly episodeId: string;
  readonly subject: string;
  readonly candidate: string;
  readonly axis: number;
}): Promise<{ readonly subjectId: string; readonly candidateId: string }> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id: input.episodeId,
    now: NOW,
    properties: {
      text: `the ${input.subject} migration`,
      session_id: `${input.episodeId}-session`,
    },
  });
  const ids: string[] = [];
  for (const [index, name] of [input.subject, input.candidate].entries()) {
    const [merged] = await mergeEntities(
      harness.driver,
      [
        {
          name,
          nameNorm: name.toLowerCase(),
          type: 'tool',
          text: `${name} (tool): the ingest service`,
          sourceEpisodeId: input.episodeId,
          extractionMethod: 'test',
          confidence: 0.8,
          occurredAt: NOW,
        },
      ],
      NOW,
    );
    if (merged === undefined) {
      throw new Error(`failed to seed ${name}`);
    }
    await writeEntityVectors(harness.driver, [
      { id: merged.id, nameVector: nearVector(input.axis, index === 0 ? 0 : 0.05) },
    ]);
    ids.push(merged.id);
  }
  const [subjectId, candidateId] = ids as [string, string];
  await linkEntityMentions(harness.driver, {
    episodeId: input.episodeId,
    entityIds: [subjectId],
    now: NOW,
    confidence: 0.8,
    provenance: ['test'],
  });

  establishEntityEvidence(db, subjectId, NOW);
  establishEntityEvidence(db, candidateId, NOW);
  seedEntitySource(db, {
    sourceId: input.episodeId,
    sessionId: `${input.episodeId}-session`,
    content: stopCapture(input.subject, minutesAgo(1)),
    nodeIds: [subjectId],
    at: NOW,
  });
  for (let index = 0; index < 3; index += 1) {
    seedEntitySource(db, {
      sourceId: `${input.episodeId}-earlier-${String(index)}`,
      sessionId: `${input.episodeId}-session-${String(index)}`,
      content: stopCapture(input.subject, minutesAgo(60 + index)),
      nodeIds: [subjectId],
      at: NOW,
    });
  }
  seedEntitySource(db, {
    sourceId: `${input.episodeId}-candidate`,
    sessionId: `${input.episodeId}-candidate-session`,
    content: {
      turns: [
        {
          role: 'assistant',
          text: `${input.candidate} restarted cleanly.`,
          occurred_at: minutesAgo(5).toISOString(),
        },
      ],
    },
    nodeIds: [candidateId],
    at: NOW,
  });
  return { subjectId, candidateId };
}

function orchestrator(judge: ScriptedEntityJudge, seam: JudgmentEvidence): ReflectionOrchestrator {
  return new ReflectionOrchestrator(
    {
      driver: harness.driver,
      db,
      provider: { embed: async () => [], generate: judge.generate },
      logger,
      evidence: seam,
      publications: coordinator,
    },
    [new EntityDedupStage({ mode: 'propose' })],
  );
}

/** What the build before bounded entity evidence answered for this pair: over its read budget. */
function overBudget(): JudgmentEvidence {
  return {
    assemble: (pair) =>
      Promise.resolve({
        status: 'incomplete',
        reasons: pair.sides.map((side) => ({
          address: idAddress(side.nodeId),
          field: 'source_content' as const,
          reason: 'budget_limit' as const,
          required: true,
        })),
        revision: buildEvidenceRevision([]),
      }),
    confirm: () => ({ status: 'current' }),
  };
}

function withheldReasons(run: ReflectionRun): readonly string[] {
  return (
    run.summary.stages
      .find((stage) => stage.name === 'entity-dedup')
      ?.withheldWork?.map((work) => work.reason) ?? []
  );
}

function prompts(judge: ScriptedEntityJudge): readonly string[] {
  return judge.calls.map((call) => call.messages.map((message) => message.content).join('\n'));
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-entity-dedup-evidence-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: DIMENSION });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...PUBLICATION_HANDLERS],
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

describe('entity dedup on bounded evidence', () => {
  it('judges a pair the whole-source read withheld, and the retried job completes', async () => {
    const episodeId = 'episode-zephyr';
    await seedPair({
      episodeId,
      subject: 'Zephyr Ingest',
      candidate: 'Zephyr Ingestor',
      axis: 0,
    });
    const archived = db
      .prepare('SELECT sum(length(CAST(payload_json AS BLOB))) AS bytes FROM experience_archive')
      .get() as { bytes: number };
    expect(archived.bytes).toBeGreaterThan(256 * 1024);

    const before = await orchestrator(scriptedEntityJudge(), overBudget()).run(episodeId, {
      now: NOW,
    });

    expect(before.applied).toBe(false);
    expect(withheldReasons(before)).toContain('budget_limit, budget_limit');

    const judge = scriptedEntityJudge();
    const after = await orchestrator(judge, evidence).run(episodeId, { now: NOW });

    expect(withheldReasons(after)).toEqual([]);
    expect(after.applied).toBe(true);
    expect(judge.calls).toHaveLength(2);
    for (const prompt of prompts(judge)) {
      expect(prompt).toContain('excerpts, not whole sources');
      expect(prompt).toContain(`[prompting episode] source ${episodeId}`);
      expect(prompt).toContain('Zephyr Ingest is the service that owns this queue.');
      expect(prompt).toContain('Zephyr Ingestor restarted cleanly.');
      expect(prompt).toContain("described as (reflection's interpretation, not captured text)");
    }
    expect(
      listEntityMergeProposals(db).filter((proposal) => proposal.episodeId === episodeId),
    ).toHaveLength(1);
  }, 180_000);

  it('holds the pair when a shown source is forgotten while the judge answers', async () => {
    const episodeId = 'episode-lumen';
    await seedPair({ episodeId, subject: 'Lumen Store', candidate: 'Lumen Storage', axis: 4 });
    const answering = scriptedEntityJudge();
    let forgotten = false;
    const judge: ScriptedEntityJudge = {
      calls: answering.calls,
      generate: async (request) => {
        if (!forgotten) {
          forgotten = true;
          commitSourceState(db, {
            sourceId: episodeId,
            stateKind: 'forgotten',
            operationId: `forget:${episodeId}`,
            at: NOW,
          });
        }
        return answering.generate(request);
      },
    };

    const run = await orchestrator(judge, evidence).run(episodeId, { now: NOW });

    expect(judge.calls.length).toBeGreaterThan(0);
    expect(withheldReasons(run)).toEqual(['evidence_stale']);
    expect(run.applied).toBe(false);
    expect(
      listEntityMergeProposals(db).filter((proposal) => proposal.episodeId === episodeId),
    ).toEqual([]);
  }, 180_000);
});
