import {
  DEFAULTS,
  EntityDedupStage,
  listEntityMergeProposals,
  PIPELINE_VERSION,
  resolveProviderRouting,
  writeStampedNode,
} from '@aion/core';
import { linkEntityMentions } from '@aion/core/infrastructure/graph/entity-mention-queries.js';
import {
  mergeEntities,
  writeEntityVectors,
} from '@aion/core/infrastructure/graph/entity-queries.js';
import {
  listEntityMergeDecisions,
  type EntityMergeDecision,
} from '@aion/core/infrastructure/sqlite/entity-merge-decisions.js';
import type { EntityMergeProposal } from '@aion/core/infrastructure/sqlite/entity-merge-proposals.js';
import { DEFAULT_ENTITY_MERGE_MODE } from '@aion/core/reflection/application/stages/entity-dedup.js';
import { normalizeEntityName } from '@aion/core/reflection/domain/entity-extraction.js';
import {
  entityNameVectorText,
  vectorInputHash,
} from '@aion/core/reflection/domain/vector-input.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CASCADE_BATTERY,
  CASCADE_CASE_CLASSES,
  casesOfClass,
  type CascadeCase,
  type CascadeSide,
} from './entity-cascade-precision.fixture.js';
import {
  crossCaseDecisions,
  decisionFor,
  didWhat,
  falsePositives,
  judgedMerges,
  judgedPrecision,
  precision,
  ratio,
  tierOf,
  truePositives,
  type Scored,
  type SeededCase,
} from './entity-cascade-precision.scoring.js';
import { GateSubstrate, REMOTE_JUDGE_ABSENT  } from './gate-substrate.fixture.js';

/**
 * The cascade's shipped default, measured rather than argued.
 *
 * Every pair is built into a real graph and decided by the shipped stage: tier 0 reads the name
 * keys, tier 1 nominates from the name vectors and from one GDS pass over shared episodes, tier
 * 2 measures what the two share, and tier 3 puts the facts to the two-pass judge. Nothing here
 * rebuilds a prompt or a predicate, so the number belongs to the pipeline rather than to a
 * pipeline a test wired.
 *
 * The rule was written before the numbers: auto-merge precision at or above 0.9 ships
 * `AION_ENTITY_MERGE_MODE=unanimous`, anything less ships `propose`. Precision counts every
 * merge the cascade made without a person, tier 0 included, because a tier-0 merge writes
 * whatever the mode says. The last test asserts the shipped default still matches what this run
 * measures, in both directions.
 *
 * The stage runs pinned to `unanimous` here whatever ships. The battery has to see what the
 * judge tier would do before the rule can decide whether it may do it; a battery that ran in the
 * shipped mode could never measure its way back out of `propose`.
 *
 * Recall is reported and gates nothing, and it is conditional on nomination: every pair here
 * shares an episode, so the bulk pass puts all 24 in front of the evidence tiers whatever the
 * name vectors score. What a pair scores is printed instead. `entityDedupThreshold` was derived
 * against nomic-embed-text and describes a space this model does not have, which is Phase 4.4's
 * to re-derive; that distribution is the seed for it.
 */

const NOW = new Date('2026-09-01T00:00:00.000Z');

/** Two model calls per judged pair against a remote route, plus the graph work behind each. */
const BATTERY_DEADLINE_MS = 900_000;

/** The pre-registered bar. */
const PRECISION_BAR = 0.9;

/**
 * The smallest judge-tier sample allowed to pick the shipped mode. Tier 0 merges the separator
 * class deterministically and those merges count toward the headline, so a run that judged one
 * pair would ship `unanimous` on a measurement of the deterministic tier. Four is the floor the
 * fixture population supports; a run under it has not measured the thing the rule is about.
 */
const JUDGED_SAMPLE_FLOOR = 4;

const SESSION_ID = 'entity-cascade-battery';

let substrate: GateSubstrate;
let scored: Scored[] = [];
let decisions: EntityMergeDecision[] = [];
let proposals: EntityMergeProposal[] = [];

/**
 * The route `testGenerationProvider` picks, which is the one the judge answered on. It reads
 * the key from the environment rather than from config, so a config-only reading would name a
 * model this battery never called.
 */
function batteryApiKey(): string {
  const key = process.env.AION_ANTHROPIC_API_KEY ?? '';
  return process.env.TEST_AION_GENERATION === 'local' ? '' : key;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [index, value] of left.entries()) {
    const other = right[index] ?? 0;
    dot += value * other;
    leftNorm += value * value;
    rightNorm += other * other;
  }
  const magnitude = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return magnitude === 0 ? 0 : dot / magnitude;
}

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(substrate.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt: NOW,
    properties: { text: id, session_id: SESSION_ID },
  });
}

async function seedSide(entry: CascadeCase, side: CascadeSide, episodeId: string): Promise<string> {
  const [merged] = await mergeEntities(
    substrate.driver,
    [
      {
        name: side.name,
        nameNorm: normalizeEntityName(side.name),
        type: side.type,
        text: side.description,
        sourceEpisodeId: episodeId,
        extractionMethod: 'cascade_battery',
        confidence: 1,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  if (merged === undefined) {
    throw new Error(`the battery failed to seed ${entry.key}: ${side.name}`);
  }
  return merged.id;
}

/**
 * One case's slice of the graph: a private episode per side, plus the shared ones the case
 * declares. The stage runs over a shared episode, so both sides are subjects of the run.
 */
async function seedCase(entry: CascadeCase): Promise<Omit<SeededCase, 'cosine' | 'judged'>> {
  const leftEpisode = `${entry.key}-left`;
  const rightEpisode = `${entry.key}-right`;
  const shared = Array.from({ length: entry.coMentions }, (_, index) =>
    sharedEpisodeId(entry, index),
  );
  for (const id of [leftEpisode, rightEpisode, ...shared]) {
    await seedEpisode(id);
  }

  const leftId = await seedSide(entry, entry.left, leftEpisode);
  const rightId = await seedSide(entry, entry.right, rightEpisode);
  const mentions: readonly (readonly [string, readonly string[]])[] = [
    [leftEpisode, [leftId]],
    [rightEpisode, [rightId]],
    ...shared.map((id) => [id, [leftId, rightId]] as const),
  ];
  for (const [episodeId, entityIds] of mentions) {
    await linkEntityMentions(substrate.driver, {
      episodeId,
      entityIds,
      now: NOW,
      confidence: 1,
      provenance: ['cascade_battery'],
    });
  }
  return { entry, leftId, rightId };
}

function sharedEpisodeId(entry: CascadeCase, index: number): string {
  return `${entry.key}-shared-${String(index)}`;
}

async function embedNames(
  seeded: readonly Omit<SeededCase, 'cosine' | 'judged'>[],
): Promise<Map<string, number>> {
  const rows = seeded.flatMap((row) => [
    { id: row.leftId, name: row.entry.left.name },
    { id: row.rightId, name: row.entry.right.name },
  ]);
  const texts = rows.map((row) => entityNameVectorText(normalizeEntityName(row.name), []));
  const vectors = await substrate.provider.embed(texts);
  await writeEntityVectors(
    substrate.driver,
    rows.map((row, index) => ({
      id: row.id,
      nameVector: vectors[index] ?? [],
      nameVectorHash: vectorInputHash(texts[index] ?? ''),
    })),
  );

  const cosines = new Map<string, number>();
  for (const [index, row] of seeded.entries()) {
    cosines.set(row.entry.key, cosine(vectors[index * 2] ?? [], vectors[index * 2 + 1] ?? []));
  }
  return cosines;
}

/** The pipeline's stage, on the pipeline's knobs, with only the mode pinned. */
function batteryStage(): EntityDedupStage {
  return new EntityDedupStage({
    model: DEFAULTS.models.reflect,
    timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
    similarityThreshold: DEFAULTS.reflection.entityDedupThreshold,
    sharedEpisodeJaccardFloor: DEFAULTS.reflection.entityNominationJaccardFloor,
    mode: 'unanimous',
  });
}

async function runCase(row: Omit<SeededCase, 'cosine' | 'judged'>): Promise<number> {
  const episodeId = sharedEpisodeId(row.entry, 0);
  const outcome = await batteryStage().run({
    driver: substrate.driver,
    db: substrate.db,
    provider: substrate.provider,
    episodeId,
    episode: { id: episodeId, sessionId: SESSION_ID, text: '', turns: [] },
    logger: substrate.logger,
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  });
  if (outcome.status !== 'ok') {
    throw new Error(`the cascade did not run on ${row.entry.key}: ${outcome.summary}`);
  }
  return typeof outcome.counts?.merge_judgments === 'number' ? outcome.counts.merge_judgments : 0;
}

beforeAll(async () => {
  // The key so the reported route is the route the provider took. `testGenerationProvider`
  // decides from the environment and the substrate's config does not carry the key, so without
  // this the battery would name the local model while the judge answered on the remote one.
  substrate = new GateSubstrate('entity-cascade', {
    tune: (config) => ({
      ...config,
      anthropic: { ...config.anthropic, apiKey: batteryApiKey() },
    }),
  });
  await substrate.open();

  const seeded: Omit<SeededCase, 'cosine' | 'judged'>[] = [];
  for (const entry of CASCADE_BATTERY) {
    seeded.push(await seedCase(entry));
  }
  const cosines = await embedNames(seeded);

  const rows: SeededCase[] = [];
  for (const row of seeded) {
    const judged = await runCase(row);
    rows.push({ ...row, cosine: cosines.get(row.entry.key) ?? 0, judged });
  }

  decisions = listEntityMergeDecisions(substrate.db);
  proposals = listEntityMergeProposals(substrate.db);
  scored = rows.map((row) => {
    const decision = decisionFor(row, decisions);
    const merged = decision !== undefined;
    return {
      ...row,
      merged,
      ...(decision === undefined ? {} : { tier: decision.tier }),
      proposed: proposals.some(
        (proposal) =>
          [proposal.leftId, proposal.rightId].sort().join(',') ===
          [row.leftId, row.rightId].sort().join(','),
      ),
      correct: merged === row.entry.duplicate,
    };
  });
}, BATTERY_DEADLINE_MS);

afterAll(async () => {
  await substrate.close();
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('the 24-pair entity cascade battery', () => {
  it('names the route it measured, so the number belongs to a model', () => {
    const route = resolveProviderRouting(substrate.config).roles.reflect;
    console.log(
      `cascade battery route: provider ${route.provider}, model ${route.model}, ` +
        `reason ${route.reason}, local tag ${route.localModel}; embeddings on ` +
        `${substrate.config.models.embed} at ${String(substrate.config.models.embedDimension)} dimensions`,
    );

    expect(scored).toHaveLength(CASCADE_BATTERY.length);
    // A run where the judge never answered would report a precision drawn from tier 0 alone
    // without saying so, and tier 0 is the tier the mode does not govern.
    const judged = scored.reduce((total, row) => total + row.judged, 0);
    console.log(`pairs sent to the two-pass judge: ${String(judged)}`);
    expect(judged).toBeGreaterThan(0);
  });

  it('scores every merge the cascade made against the pre-committed truth', () => {
    const tp = truePositives(scored);
    const fp = falsePositives(scored, decisions);
    const fn = scored.filter((row) => !row.merged && row.entry.duplicate).length;
    const tn = scored.filter((row) => !row.merged && !row.entry.duplicate).length;

    console.log(
      `auto-merges: TP ${String(tp)}, FP ${String(fp)}, FN ${String(fn)}, TN ${String(tn)} | ` +
        `precision ${precision(scored, decisions).toFixed(3)}, recall ${ratio(tp, 12).toFixed(3)}`,
    );
    console.log(
      `by tier: ${String(decisions.filter((row) => row.tier === 'tier0').length)} tier-0 merge(s), ` +
        `${String(decisions.filter((row) => row.tier === 'tier3').length)} judged merge(s), ` +
        `${String(proposals.length)} pair(s) left as proposals`,
    );
    for (const caseClass of CASCADE_CASE_CLASSES) {
      console.log(`  class ${caseClass}: ${tierOf(scored, caseClass)} correct`);
    }
    for (const row of scored.filter((entry) => !entry.correct)) {
      console.log(
        `  wrong on ${row.entry.key} (${row.entry.caseClass}): the cascade ${didWhat(row)}, ` +
          `truth ${String(row.entry.duplicate)} because ${row.entry.truthNote}`,
      );
    }
    for (const decision of crossCaseDecisions(scored, decisions)) {
      console.log(
        `  merged across two cases at ${decision.tier}: ${[
          decision.canonicalId,
          ...decision.memberIds,
        ].join(' + ')}`,
      );
    }

    // The four buckets partition the run by construction and cannot disagree with it. What can
    // is the run itself: a pair the cascade both merged and left in the residue lane is counted
    // here as a merge while the operator is asked to decide it, and precision would be measured
    // over a population the queue contradicts.
    expect(scored.filter((row) => row.merged && row.proposed).map((row) => row.entry.key)).toEqual(
      [],
    );
    // Every case is scoreable by construction, so a battery that scored fewer has a fixture
    // problem rather than a measurement.
    expect(CASCADE_BATTERY.filter((entry) => entry.duplicate)).toHaveLength(12);
    expect(casesOfClass('separator')).toHaveLength(3);
    expect(casesOfClass('namesake')).toHaveLength(6);
  });

  /**
   * Reported, not asserted. `entityDedupThreshold` was derived against nomic-embed-text and
   * describes a space this model does not have; what the two distributions look like here is
   * the seed for Phase 4.4's re-derivation, and a run where they separate cleanly is news.
   */
  it('reports what the name vectors score under the shipped embedding model', () => {
    const same = scored.filter((row) => row.entry.duplicate).map((row) => row.cosine);
    const other = scored.filter((row) => !row.entry.duplicate).map((row) => row.cosine);
    const floor = DEFAULTS.reflection.entityDedupThreshold;
    const band = (values: readonly number[]): string => {
      const sorted = [...values].sort((left, right) => left - right);
      const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
      return (
        `min ${(sorted[0] ?? 0).toFixed(3)}, median ${median.toFixed(3)}, ` +
        `max ${(sorted[sorted.length - 1] ?? 0).toFixed(3)}, ` +
        `at or above ${String(floor)}: ${String(values.filter((value) => value >= floor).length)}/${String(values.length)}`
      );
    };

    console.log(`name cosine, duplicates:     ${band(same)}`);
    console.log(`name cosine, not duplicates: ${band(other)}`);
    for (const row of [...scored].sort((left, right) => right.cosine - left.cosine).slice(0, 5)) {
      console.log(
        `  highest: ${row.entry.left.name} against ${row.entry.right.name} at ` +
          `${row.cosine.toFixed(4)}, truth ${String(row.entry.duplicate)}`,
      );
    }

    // A pair whose name vectors never landed reads as 0.000 and prints as a band separating
    // cleanly at the floor, which is the one way this report can describe a space nobody
    // measured. Every pair is embedded in `beforeAll`, so a zero here is a missing vector.
    expect(scored.filter((row) => row.cosine <= 0).map((row) => row.entry.key)).toEqual([]);
  });

  /**
   * Tier 0 asks no model and the mode does not govern it, so a wrong deterministic merge is a
   * defect in the tier rather than a measurement of a judge. It fails here on its own.
   */
  it('merges nothing at the deterministic tier that is not one thing under two spellings', () => {
    const wrong = scored.filter((row) => row.tier === 'tier0' && !row.entry.duplicate);
    for (const row of wrong) {
      console.log(`  tier 0 merged ${row.entry.key}, which is ${row.entry.truthNote}`);
    }

    expect(wrong).toHaveLength(0);
    expect(
      crossCaseDecisions(scored, decisions).filter((decision) => decision.tier === 'tier0'),
    ).toHaveLength(0);
  });

  /**
   * The pre-registered rule, asserted rather than described. It fails in both directions: a
   * cascade that drops under the bar while the shipped default still merges fails here, and so
   * does one that clears it while the default stays `propose`.
   */
  it('ships the default the measurement calls for', () => {
    const judged = judgedMerges(scored);
    const measured = precision(scored, decisions);
    const judgedOnly = judgedPrecision(scored, decisions);
    const expected =
      measured >= PRECISION_BAR && judgedOnly >= PRECISION_BAR ? 'unanimous' : 'propose';

    console.log(
      `pre-registered rule: auto-merge precision ${measured.toFixed(3)} against ` +
        `${String(PRECISION_BAR)}, over ${String(judged.length)} judged merge(s) of which ` +
        `${String(judged.filter((row) => row.entry.duplicate).length)} were duplicates; ` +
        `judge tier alone ${judgedOnly.toFixed(3)}; ` +
        `the measurement calls for '${expected}' and the shipped default is ` +
        `'${DEFAULT_ENTITY_MERGE_MODE}'`,
    );

    // The mode governs tier 3 and nothing else, and tier 0 contributes fixed true positives to
    // the headline: one judged merge beside three deterministic ones reaches 1.000 without
    // measuring the judge at all. The floor is what stops a sample that small from answering.
    expect(judged.length).toBeGreaterThanOrEqual(JUDGED_SAMPLE_FLOOR);
    // Both numbers gate `unanimous`, so the headline cannot carry a judge tier failing alone.
    expect(DEFAULT_ENTITY_MERGE_MODE).toBe(expected);
  });
});
