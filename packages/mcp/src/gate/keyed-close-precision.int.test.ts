import {
  cognitiveOptions,
  entityOptions,
  EntityExtractionStage,
  PIPELINE_VERSION,
  resolveProviderRouting,
  writeStampedNode,
} from '@aion/core';
import { runRead } from '@aion/core/infrastructure/graph/connection.js';
import { SUBJECT_PROPAGATION_METHOD } from '@aion/core/infrastructure/graph/subject-family.js';
import {
  CognitiveExtractionStage,
  DEFAULT_KEYED_CLOSE_MODE,
} from '@aion/core/reflection/application/stages/cognitive.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
  KEYED_CLOSE_METHOD,
} from '@aion/core/reflection/domain/claim-key.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GateSubstrate, REMOTE_JUDGE_ABSENT } from './gate-substrate.fixture.js';
import {
  casesOfClass,
  KEYED_BATTERY,
  KEYED_CASE_CLASSES,
  newEpisodeId,
  priorEpisodeId,
  type KeyedCase,
  type KeyedCaseClass,
} from './keyed-close-precision.fixture.js';

/**
 * The subject-keyed close's shipped default, measured rather than argued.
 *
 * Every case is two sessions told to the shipped extraction stages in order, on a real graph and
 * a live model: the entity stage resolves who the session named, the cognitive stage asks the
 * model for the subject and the attribute each claim asserts, resolution turns that subject into
 * an entity id, and the write closes whatever already holds the same key inside its own
 * transaction. Nothing here rebuilds a prompt or a predicate, so the number belongs to the
 * pipeline rather than to a pipeline a test wired.
 *
 * The rule was written before the numbers. Precision at or above 0.95 on mechanical keyed closes
 * ships `AION_KEYED_CLOSE_MODE=close`; anything less ships `judge`, where the key stays a
 * candidate generator and the two-pass unanimous judge decides the pair as it always has. Neither
 * outcome parks anything in front of a person: a missed bar costs model calls, not autonomy.
 *
 * The bar is higher than the 0.9 the two judge batteries carry because this path has no second
 * opinion in it. A wrong keyed close is made and committed in one transaction with nothing
 * downstream to argue the other side.
 *
 * Precision counts every close the key made, whichever case each side came from: a close that
 * reached across two cases is as wrong as one inside a trap, and the shared graph is what makes
 * that reachable. Recall is printed and gates nothing. A key that never matched leaves the pair
 * to the judge, which is the recoverable direction, and the classes below are built so that the
 * only recall a mechanical close can lose is recall the judge still has.
 *
 * The stage runs pinned to `close` here whatever ships, for the reason the cascade battery pins
 * `unanimous`: a battery running in the shipped mode could never measure its way out of it.
 */

/** Two generation calls per episode against a remote route, plus the graph work behind each. */
const BATTERY_DEADLINE_MS = 1_500_000;

/** The pre-registered bar. */
const PRECISION_BAR = 0.95;

/**
 * The smallest number of mechanical closes allowed to pick the shipped mode. Eight of the 24
 * cases are a genuine correction under one unchanged attribute name, and those eight are the only
 * closes the mechanism should make, so four is half the population it can act on. Precision read
 * off fewer than four closes describes an accident rather than a mechanism, and a run that keyed
 * too little has measured nothing the rule can ship on. It does not gate recall: eight closes are
 * available, four are asked for, and a run between the two still ships `close` if it is clean.
 */
const KEYED_CLOSE_SAMPLE_FLOOR = 4;

const SESSION_ID = 'keyed-close-battery';

/** The prior half happens a week before the new one, so world time separates the two claims. */
const PRIOR_AT = new Date('2026-09-01T00:00:00.000Z');

const NEW_AT = new Date('2026-09-08T00:00:00.000Z');

type CaseHalf = 'prior' | 'new';

type KeyedClaim = {
  readonly id: string;
  readonly episodeId: string;
  readonly subjectEntityId: string;
  readonly aspectNorm: string;
};

type MechanicalClose = {
  readonly newId: string;
  readonly oldId: string;
  readonly newEpisodeId: string;
  readonly oldEpisodeId: string;
};

type Scored = {
  readonly entry: KeyedCase;
  /** The keys this case's two halves stored, if extraction gave them one. */
  readonly priorKeys: readonly KeyedClaim[];
  readonly newKeys: readonly KeyedClaim[];
  /** The closes the key made inside this case, in the direction the case was told. */
  readonly closes: readonly MechanicalClose[];
  readonly correct: boolean;
};

let substrate: GateSubstrate;
let scored: Scored[] = [];
let closes: MechanicalClose[] = [];
let propagated = 0;
let keyedClaims: KeyedClaim[] = [];

const halfOf = new Map<string, { readonly entry: KeyedCase; readonly half: CaseHalf }>();

/**
 * The route `testGenerationProvider` picks, which is the one extraction answered on. It reads the
 * key from the environment rather than from config, so a config-only reading would name a model
 * this battery never called.
 */
function batteryApiKey(): string {
  const key = process.env.AION_ANTHROPIC_API_KEY ?? '';
  return process.env.TEST_AION_GENERATION === 'local' ? '' : key;
}

async function seedEpisode(id: string, text: string, occurredAt: Date): Promise<void> {
  await writeStampedNode(substrate.driver, {
    label: 'Episode',
    id,
    now: occurredAt,
    occurredAt,
    properties: { text, session_id: SESSION_ID },
  });
}

/** The pipeline's stages, on the pipeline's knobs, with only the keyed-close mode pinned. */
async function enrich(episodeId: string, text: string, occurredAt: Date): Promise<void> {
  const ctx = {
    driver: substrate.driver,
    db: substrate.db,
    provider: substrate.provider,
    episodeId,
    episode: { id: episodeId, sessionId: SESSION_ID, text, turns: [] },
    logger: substrate.logger,
    now: occurredAt,
    occurredAt,
    pipelineVersion: PIPELINE_VERSION,
  };

  const entities = await new EntityExtractionStage(entityOptions(substrate.config)).run(ctx);
  if (entities.status === 'failed') {
    throw new Error(`entity extraction failed on ${episodeId}: ${entities.summary}`);
  }
  const cognitive = await new CognitiveExtractionStage({
    ...cognitiveOptions(substrate.config),
    keyedCloseMode: 'close',
  }).run(ctx);
  if (cognitive.status === 'failed') {
    throw new Error(`cognitive extraction failed on ${episodeId}: ${cognitive.summary}`);
  }
}

/** Every claim the run keyed, so a case can say whether the mechanism had anything to match on. */
const KEYED_CLAIMS = [
  'MATCH (n:Memory)-[:EXTRACTED_FROM]->(e:Episode)',
  `WHERE n.${CLAIM_SUBJECT_PROPERTY} IS NOT NULL AND n.${CLAIM_ASPECT_PROPERTY} IS NOT NULL`,
  'RETURN n.id AS id, e.id AS episode_id,',
  `       n.${CLAIM_SUBJECT_PROPERTY} AS subject, n.${CLAIM_ASPECT_PROPERTY} AS aspect`,
  'ORDER BY episode_id, id',
].join('\n');

/** Every close the key itself made, read off the lineage edge's provenance rather than a counter. */
const CLOSES_BY_METHOD = [
  'MATCH (newClaim)-[r:SUPERSEDES]->(old)',
  'WHERE $method IN r.provenance',
  'MATCH (newClaim)-[:EXTRACTED_FROM]->(newEpisode:Episode)',
  'MATCH (old)-[:EXTRACTED_FROM]->(oldEpisode:Episode)',
  'RETURN newClaim.id AS new_id, old.id AS old_id,',
  '       newEpisode.id AS new_episode_id, oldEpisode.id AS old_episode_id',
  'ORDER BY old_id, new_id',
].join('\n');

async function readClosesBy(method: string): Promise<MechanicalClose[]> {
  return runRead(substrate.driver, CLOSES_BY_METHOD, { method }, (row) => ({
    newId: row.new_id as string,
    oldId: row.old_id as string,
    newEpisodeId: row.new_episode_id as string,
    oldEpisodeId: row.old_episode_id as string,
  }));
}

/** A close is right when it runs from a case's later half to its own earlier half, and the case corrects. */
function isCorrect(close: MechanicalClose): boolean {
  const from = halfOf.get(close.newEpisodeId);
  const to = halfOf.get(close.oldEpisodeId);
  if (from === undefined || to === undefined) {
    return false;
  }
  return (
    from.entry.key === to.entry.key &&
    from.half === 'new' &&
    to.half === 'prior' &&
    from.entry.corrects
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function precision(): number {
  return ratio(closes.filter(isCorrect).length, closes.length);
}

function correctingCases(): readonly KeyedCase[] {
  return KEYED_BATTERY.filter((entry) => entry.corrects);
}

function recall(): number {
  const closed = scored.filter((row) => row.entry.corrects && row.correct).length;
  return ratio(closed, correctingCases().length);
}

/** Closes that ran between two different cases, which the shared graph is what makes reachable. */
function crossCaseCloses(): readonly MechanicalClose[] {
  return closes.filter((close) => {
    const from = halfOf.get(close.newEpisodeId)?.entry.key;
    const to = halfOf.get(close.oldEpisodeId)?.entry.key;
    return from === undefined || to === undefined || from !== to;
  });
}

function classScore(caseClass: KeyedCaseClass): string {
  const rows = scored.filter((row) => row.entry.caseClass === caseClass);
  return `${String(rows.filter((row) => row.correct).length)}/${String(rows.length)}`;
}

function describeKeys(claims: readonly KeyedClaim[]): string {
  return claims.length === 0
    ? 'none'
    : claims.map((claim) => `${claim.subjectEntityId.slice(0, 8)}/${claim.aspectNorm}`).join(', ');
}

beforeAll(async () => {
  // The key so the reported route is the route the provider took. `testGenerationProvider` decides
  // from the environment and the substrate's config does not carry the key, so without this the
  // battery would name the local model while extraction answered on the remote one.
  substrate = new GateSubstrate('keyed-close', {
    tune: (config) => ({
      ...config,
      anthropic: { ...config.anthropic, apiKey: batteryApiKey() },
    }),
  });
  await substrate.open();

  for (const entry of KEYED_BATTERY) {
    halfOf.set(priorEpisodeId(entry), { entry, half: 'prior' });
    halfOf.set(newEpisodeId(entry), { entry, half: 'new' });
    await seedEpisode(priorEpisodeId(entry), entry.prior, PRIOR_AT);
    await seedEpisode(newEpisodeId(entry), entry.next, NEW_AT);
  }

  // Both halves of one case in order, then the next case. The prior claim has to be on the graph
  // and current before the new one is written, since the close runs in that write's transaction.
  for (const entry of KEYED_BATTERY) {
    await enrich(priorEpisodeId(entry), entry.prior, PRIOR_AT);
    await enrich(newEpisodeId(entry), entry.next, NEW_AT);
  }

  keyedClaims = await runRead(substrate.driver, KEYED_CLAIMS, {}, (row) => ({
    id: row.id as string,
    episodeId: row.episode_id as string,
    subjectEntityId: row.subject as string,
    aspectNorm: row.aspect as string,
  }));
  closes = await readClosesBy(KEYED_CLOSE_METHOD);
  propagated = (await readClosesBy(SUBJECT_PROPAGATION_METHOD)).length;

  scored = KEYED_BATTERY.map((entry) => {
    const owned = closes.filter(
      (close) =>
        halfOf.get(close.newEpisodeId)?.entry.key === entry.key &&
        halfOf.get(close.oldEpisodeId)?.entry.key === entry.key,
    );
    const made = owned.length > 0;
    return {
      entry,
      priorKeys: keyedClaims.filter((claim) => claim.episodeId === priorEpisodeId(entry)),
      newKeys: keyedClaims.filter((claim) => claim.episodeId === newEpisodeId(entry)),
      closes: owned,
      correct: made === entry.corrects,
    };
  });
}, BATTERY_DEADLINE_MS);

afterAll(async () => {
  await substrate.close();
});

describe.skipIf(REMOTE_JUDGE_ABSENT)('the 24-case keyed close battery', () => {
  it('names the route it measured, so the number belongs to a model', () => {
    const route = resolveProviderRouting(substrate.config).roles.reflect;
    console.log(
      `keyed close battery route: provider ${route.provider}, model ${route.model}, ` +
        `reason ${route.reason}, local tag ${route.localModel}; embeddings on ` +
        `${substrate.config.models.embed} at ${String(substrate.config.models.embedDimension)} dimensions`,
    );

    expect(scored).toHaveLength(KEYED_BATTERY.length);
    // A run that keyed nothing would report a precision over an empty population without saying
    // so, and every class below would score as correct for the wrong reason.
    console.log(`claims carrying a whole key: ${String(keyedClaims.length)}`);
    expect(keyedClaims.length).toBeGreaterThan(0);
  });

  it('scores every close the key made against the pre-committed truth', () => {
    const tp = closes.filter(isCorrect).length;
    const fp = closes.length - tp;
    const missed =
      correctingCases().length - scored.filter((r) => r.entry.corrects && r.correct).length;

    console.log(
      `keyed closes: ${String(closes.length)} total, TP ${String(tp)}, FP ${String(fp)}, ` +
        `FN ${String(missed)} | precision ${precision().toFixed(3)}, recall ${recall().toFixed(3)}`,
    );
    console.log(`family propagation took ${String(propagated)} further sibling claim(s) with them`);
    for (const caseClass of KEYED_CASE_CLASSES) {
      console.log(`  class ${caseClass}: ${classScore(caseClass)} correct`);
    }
    for (const row of scored.filter((entry) => !entry.correct)) {
      const did = row.closes.length > 0 ? 'closed the pair' : 'closed nothing';
      console.log(
        `  wrong on ${row.entry.key} (${row.entry.caseClass}): the key ${did}, truth ` +
          `${String(row.entry.corrects)} because ${row.entry.truthNote}`,
      );
      console.log(`    prior keys ${describeKeys(row.priorKeys)}`);
      console.log(`    new keys   ${describeKeys(row.newKeys)}`);
    }
    for (const close of crossCaseCloses()) {
      console.log(`  closed across two cases: ${close.newEpisodeId} took ${close.oldEpisodeId}`);
    }

    // The fixture population is what the rule is stated over, so a battery whose classes drifted
    // would be measuring a different rule under the same name.
    expect(KEYED_BATTERY).toHaveLength(24);
    expect(correctingCases()).toHaveLength(8);
    expect(casesOfClass('same-key')).toHaveLength(8);
    expect(casesOfClass('aspect-collision')).toHaveLength(6);
    expect(casesOfClass('different-aspect')).toHaveLength(6);
    expect(casesOfClass('unkeyed')).toHaveLength(4);
  });

  /**
   * Reported, not asserted. What the extractor calls an attribute is what decides whether two
   * claims about one thing ever meet, and the collision traps are where two plain-English names
   * shorten to one slug. The slugs this run produced are the seed for any later re-derivation.
   */
  it('reports the aspect slugs extraction chose, which is what the key is made of', () => {
    const keyed = scored.filter((row) => row.priorKeys.length > 0 && row.newKeys.length > 0);
    console.log(
      `cases with a key on both halves: ${String(keyed.length)}/${String(scored.length)}`,
    );
    for (const row of scored) {
      console.log(
        `  ${row.entry.key} (${row.entry.caseClass}): prior [${describeKeys(row.priorKeys)}] ` +
          `new [${describeKeys(row.newKeys)}]`,
      );
    }

    // A run where no case keyed both halves has told the mechanism nothing to match, and every
    // negative class would read as correct because nothing could have closed.
    expect(keyed.length).toBeGreaterThan(0);
  });

  /**
   * A close inside a trap is what the bar is spent on, so it is named here and scored by the rule
   * rather than failed twice. Eight closes are available, so one wrong close already puts
   * precision under 0.95, and a run that misses the bar ships `judge` rather than leaving a red
   * suite behind.
   *
   * A close between two identities the graph itself holds as separate is a different thing. The
   * two claims key on different entity ids, so no reading of an attribute name reaches it, and it
   * fails here on its own.
   */
  it('never closes across two subjects the graph holds as separate identities', () => {
    for (const row of scored.filter((entry) => !entry.entry.corrects && entry.closes.length > 0)) {
      console.log(`  the key closed ${row.entry.key}, which is ${row.entry.truthNote}`);
    }

    expect(crossCaseCloses()).toEqual([]);
  });

  /**
   * The pre-registered rule, asserted rather than described. It fails in both directions: a
   * mechanism that drops under the bar while the shipped default still closes fails here, and so
   * does one that clears it while the default stays `judge`.
   */
  it('ships the default the measurement calls for', () => {
    const measured = precision();
    const enough = closes.length >= KEYED_CLOSE_SAMPLE_FLOOR;
    const expected = measured >= PRECISION_BAR && enough ? 'close' : 'judge';

    console.log(
      `pre-registered rule: keyed-close precision ${measured.toFixed(3)} against ` +
        `${String(PRECISION_BAR)}, over ${String(closes.length)} mechanical close(s) against a ` +
        `floor of ${String(KEYED_CLOSE_SAMPLE_FLOOR)}; recall ${recall().toFixed(3)} gates ` +
        `nothing; the measurement calls for '${expected}' and the shipped default is ` +
        `'${DEFAULT_KEYED_CLOSE_MODE}'`,
    );

    expect(DEFAULT_KEYED_CLOSE_MODE).toBe(expected);
  });
});
