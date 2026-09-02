import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, supersede, writeStampedNode } from './bitemporal.js';
import {
  CLAIM_ASPECT_PROPERTY,
  CLAIM_SUBJECT_PROPERTY,
  TEMPORAL_CLASS_PROPERTY,
  VALID_HORIZON_PROPERTY,
} from './claim-key-queries.js';
import { writeCognitiveNode, type CognitiveNodeWrite } from './cognitive-queries.js';
import { upsertEdge } from './edges.js';
import { PRIOR_DESCRIPTIONS_PROPERTY } from './entity-description-queries.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { runGraphMigrations } from './migrations.js';
import { ENTITY_NAME_NORM_PROPERTY, ENTITY_NAME_PROPERTY } from './seed-queries.js';
import { supersedeSubjectFamily } from './subject-family.js';
import {
  nodeProperties,
  supersedingNodeIds,
  supersessionEdge,
} from './test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { foldAspect, readingHorizon } from '../../reflection/domain/claim-key.js';
import { foldName } from '../../reflection/domain/name-fold.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';

const EMBED_DIMENSION = 8;

/** The episode clock every claim in this file was extracted against. */
const OCCURRED_AT = new Date('2026-09-01T12:00:00.000Z');

/** The write clock, deliberately later than the episode's, so a horizon off the wrong one shows. */
const NOW = new Date('2026-09-04T09:30:00.000Z');

const HORIZON_DAYS = 30;

const FAMILY_FLOOR = 0.85;

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: { text: `episode ${id}`, session_id: 'session-keyed' },
  });
}

async function seedEntity(id: string, name: string, gloss?: string): Promise<string> {
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    occurredAt: OCCURRED_AT,
    properties: {
      [ENTITY_NAME_PROPERTY]: name,
      [ENTITY_NAME_NORM_PROPERTY]: foldName(name),
      ...(gloss === undefined ? {} : { [MEMORY_PROPERTIES.text]: gloss }),
    },
  });
  return id;
}

async function mention(episodeId: string, entityId: string): Promise<void> {
  await upsertEdge(harness.driver, {
    type: ENTITY_MENTION_TYPE,
    sourceId: episodeId,
    targetId: entityId,
    strength: 1,
    confidence: 1,
    signals: ['fixture'],
    provenance: ['fixture'],
    now: NOW,
  });
}

function aspect(text: string): string {
  const folded = foldAspect(text);
  if (folded === undefined) {
    throw new Error(`the fixture aspect ${text} does not fold to a key`);
  }
  return folded;
}

type ClaimInput = Omit<CognitiveNodeWrite, 'label' | 'occurredAt' | 'now'> & {
  readonly label?: CognitiveNodeWrite['label'];
};

type WrittenClaim = Awaited<ReturnType<typeof writeCognitiveNode>>;

async function writeClaim(input: ClaimInput): Promise<WrittenClaim> {
  return writeCognitiveNode(harness.driver, {
    label: 'Concept',
    occurredAt: OCCURRED_AT,
    now: NOW,
    ...input,
  });
}

type FamilyFixture = {
  /** The judged claim, keyed on the repository's default branch. */
  readonly prior: WrittenClaim;
  /** The same repository, a second attribute, and a slug that matches nothing on the judged claim. */
  readonly otherAspect: WrittenClaim;
  /** No key at all, so only the name test can reach it. */
  readonly unkeyed: WrittenClaim;
  readonly correction: WrittenClaim;
};

/**
 * Three siblings containment and the floor admit on their own: each names the repository in its
 * own text and carries the judged claim's vector. The key is the only thing that can separate
 * them, which is what makes the mode visible.
 *
 * Each seeding takes its own repository, because `name_norm` is unique across entities and one
 * close per family keeps the second seeding reading nodes the first one did not touch.
 */
async function seedFamily(
  suffix: string,
  repositoryName: string,
  keyedClose?: CognitiveNodeWrite['keyedClose'],
): Promise<FamilyFixture> {
  const observed = `ep-family-old-${suffix}`;
  const correcting = `ep-family-new-${suffix}`;
  await seedEpisode(observed);
  await seedEpisode(correcting);
  const repository = await seedEntity(`entity-repo-${suffix}`, repositoryName);
  await mention(observed, repository);
  const vector = [1, 0, 0, 0, 0, 0, 0, 0];
  const key = { subjectEntityId: repository, aspectNorm: aspect('default branch') };

  return {
    prior: await writeClaim({
      episodeId: observed,
      text: `The ${repositoryName} default branch is main.`,
      contentVector: vector,
      ...key,
    }),
    otherAspect: await writeClaim({
      episodeId: observed,
      text: `The ${repositoryName} default reviewer is the release captain.`,
      contentVector: vector,
      subjectEntityId: repository,
      aspectNorm: aspect('default reviewer'),
    }),
    unkeyed: await writeClaim({
      episodeId: observed,
      text: `The ${repositoryName} is mirrored to the archive host nightly.`,
      contentVector: vector,
    }),
    correction: await writeClaim({
      episodeId: correcting,
      text: `The ${repositoryName} default branch is trunk.`,
      contentVector: vector,
      ...key,
      ...(keyedClose === undefined ? {} : { keyedClose }),
    }),
  };
}

async function isClosed(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] !== undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-claim-key-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the claim key on a cognitive node', () => {
  it('stores the subject and aspect as properties of the claim itself', async () => {
    await seedEpisode('ep-props');
    const written = await writeClaim({
      episodeId: 'ep-props',
      text: 'The Harbor index refresh interval is 15 minutes.',
      subjectEntityId: 'entity-harbor-index',
      aspectNorm: aspect('Refresh Interval'),
      temporalClass: 'standing',
    });

    const properties = await nodeProperties(harness.driver, written.node.id);
    expect(properties[CLAIM_SUBJECT_PROPERTY]).toBe('entity-harbor-index');
    expect(properties[CLAIM_ASPECT_PROPERTY]).toBe('refresh interval');
    expect(properties[TEMPORAL_CLASS_PROPERTY]).toBe('standing');
  });

  it('writes none of the key properties for a claim that declined a key', async () => {
    await seedEpisode('ep-unkeyed');
    const written = await writeClaim({
      episodeId: 'ep-unkeyed',
      text: 'Harbor index was rebuilt over the weekend.',
      readingHorizonDays: HORIZON_DAYS,
    });

    const properties = await nodeProperties(harness.driver, written.node.id);
    expect(properties[CLAIM_SUBJECT_PROPERTY]).toBeUndefined();
    expect(properties[CLAIM_ASPECT_PROPERTY]).toBeUndefined();
    expect(properties[TEMPORAL_CLASS_PROPERTY]).toBeUndefined();
    expect(properties[VALID_HORIZON_PROPERTY]).toBeUndefined();
  });

  it('dates a reading horizon from the episode clock and leaves the claim current', async () => {
    await seedEpisode('ep-reading');
    const written = await writeClaim({
      episodeId: 'ep-reading',
      text: 'The Harbor index holds 4.2 million rows.',
      subjectEntityId: 'entity-harbor-index',
      aspectNorm: aspect('row count'),
      temporalClass: 'reading',
      readingHorizonDays: HORIZON_DAYS,
    });

    const properties = await nodeProperties(harness.driver, written.node.id);
    expect(properties[VALID_HORIZON_PROPERTY]).toEqual(readingHorizon(OCCURRED_AT, HORIZON_DAYS));
    expect(properties[VALID_HORIZON_PROPERTY]).toEqual(new Date('2026-10-01T12:00:00.000Z'));
    // A horizon is an annotation the read side derives, so the claim stays open on both
    // timelines and every currency predicate goes on returning it.
    expect(properties[BITEMPORAL_PROPERTIES.validUntil]).toBeUndefined();
    expect(await isClosed(written.node.id)).toBe(false);
  });

  it('writes no horizon for a standing claim or a trend, however many horizon days it is given', async () => {
    await seedEpisode('ep-no-horizon');
    const standing = await writeClaim({
      episodeId: 'ep-no-horizon',
      text: 'Harbor index is owned by the platform group.',
      subjectEntityId: 'entity-harbor-index',
      aspectNorm: aspect('owner'),
      temporalClass: 'standing',
      readingHorizonDays: HORIZON_DAYS,
    });
    const trend = await writeClaim({
      episodeId: 'ep-no-horizon',
      text: 'Harbor index query latency has been falling since the rebuild.',
      subjectEntityId: 'entity-harbor-index',
      aspectNorm: aspect('query latency direction'),
      temporalClass: 'trend',
      readingHorizonDays: HORIZON_DAYS,
    });

    const standingProperties = await nodeProperties(harness.driver, standing.node.id);
    const trendProperties = await nodeProperties(harness.driver, trend.node.id);
    expect(standingProperties[TEMPORAL_CLASS_PROPERTY]).toBe('standing');
    expect(standingProperties[VALID_HORIZON_PROPERTY]).toBeUndefined();
    expect(trendProperties[TEMPORAL_CLASS_PROPERTY]).toBe('trend');
    expect(trendProperties[VALID_HORIZON_PROPERTY]).toBeUndefined();
  });
});

describe('the keyed close', () => {
  it('closes the open claim sharing the key and names the key on the lineage edge', async () => {
    await seedEpisode('ep-retry-old');
    await seedEpisode('ep-retry-new');
    const key = { subjectEntityId: 'entity-ingest-lane', aspectNorm: aspect('retry count') };
    const prior = await writeClaim({
      episodeId: 'ep-retry-old',
      text: 'The ingest lane retry count is 3.',
      ...key,
      temporalClass: 'standing',
    });

    const correction = await writeClaim({
      episodeId: 'ep-retry-new',
      text: 'The ingest lane retry count is 8.',
      ...key,
      temporalClass: 'standing',
      keyedClose: { mode: 'close', relatednessFloor: FAMILY_FLOOR },
    });

    expect(correction.keyedClose?.closedIds).toEqual([prior.node.id]);
    expect(await isClosed(prior.node.id)).toBe(true);
    expect(await supersedingNodeIds(harness.driver, prior.node.id)).toEqual([correction.node.id]);
    const edge = await supersessionEdge(harness.driver, prior.node.id);
    expect(edge?.provenance).toEqual(['keyed_close']);
    expect(edge?.signals).toEqual(['subject_key']);
    // The correction stopped being wrong when the correcting experience happened, not when the
    // write landed.
    const closed = await nodeProperties(harness.driver, prior.node.id);
    expect(closed[BITEMPORAL_PROPERTIES.validUntil]).toEqual(OCCURRED_AT);
  });

  it('closes nothing when the mode is off or judge', async () => {
    await seedEpisode('ep-mode-old');
    await seedEpisode('ep-mode-off');
    await seedEpisode('ep-mode-judge');
    const key = { subjectEntityId: 'entity-mode-subject', aspectNorm: aspect('batch size') };
    const prior = await writeClaim({
      episodeId: 'ep-mode-old',
      text: 'The reconciler batch size is 100.',
      ...key,
    });

    const off = await writeClaim({
      episodeId: 'ep-mode-off',
      text: 'The reconciler batch size is 250.',
      ...key,
      keyedClose: { mode: 'off', relatednessFloor: FAMILY_FLOOR },
    });
    const judge = await writeClaim({
      episodeId: 'ep-mode-judge',
      text: 'The reconciler batch size is 500.',
      ...key,
      keyedClose: { mode: 'judge', relatednessFloor: FAMILY_FLOOR },
    });

    expect(off.keyedClose).toBeUndefined();
    expect(judge.keyedClose).toBeUndefined();
    expect(await isClosed(prior.node.id)).toBe(false);
    expect(await supersedingNodeIds(harness.driver, prior.node.id)).toEqual([]);
  });

  it('leaves a key-mate another close already took rather than closing it twice', async () => {
    await seedEpisode('ep-raced-old');
    await seedEpisode('ep-raced-first');
    await seedEpisode('ep-raced-second');
    const key = { subjectEntityId: 'entity-checkpoint-store', aspectNorm: aspect('backend') };
    const prior = await writeClaim({
      episodeId: 'ep-raced-old',
      text: 'The checkpoint store backend is Redis.',
      ...key,
    });
    // The claim that got there first carries no key of its own, so the only key-mate the second
    // correction can find is one that is already closed.
    const firstCorrection = await writeClaim({
      episodeId: 'ep-raced-first',
      text: 'The checkpoint store backend is Postgres.',
    });
    await supersede(harness.driver, {
      oldId: prior.node.id,
      newId: firstCorrection.node.id,
      now: NOW,
      validUntil: OCCURRED_AT,
      provenance: ['reflection_supersession'],
    });

    const secondCorrection = await writeClaim({
      episodeId: 'ep-raced-second',
      text: 'The checkpoint store backend is FoundationDB.',
      ...key,
      keyedClose: { mode: 'close', relatednessFloor: FAMILY_FLOOR },
    });

    // The lookup carries the currency predicate in the commit that writes the close, so a claim
    // closed between the two is invisible to it and keeps the lineage of the close it took.
    expect(secondCorrection.keyedClose?.closedIds).toEqual([]);
    expect(await supersedingNodeIds(harness.driver, prior.node.id)).toEqual([
      firstCorrection.node.id,
    ]);
    const edge = await supersessionEdge(harness.driver, prior.node.id);
    expect(edge?.provenance).toEqual(['reflection_supersession']);
  });

  it('closes nothing when the colliding claim came from the same episode', async () => {
    await seedEpisode('ep-same');
    const key = { subjectEntityId: 'entity-solstice-job', aspectNorm: aspect('cadence') };
    const first = await writeClaim({
      episodeId: 'ep-same',
      text: 'The solstice job cadence is hourly.',
      ...key,
      keyedClose: { mode: 'close', relatednessFloor: FAMILY_FLOOR },
    });

    const second = await writeClaim({
      episodeId: 'ep-same',
      text: 'The solstice job cadence is nightly.',
      ...key,
      keyedClose: { mode: 'close', relatednessFloor: FAMILY_FLOOR },
    });

    expect(second.keyedClose?.closedIds).toEqual([]);
    expect(await isClosed(first.node.id)).toBe(false);
    expect(await supersedingNodeIds(harness.driver, first.node.id)).toEqual([]);
  });

  it('never closes the node being written when its episode is replayed', async () => {
    await seedEpisode('ep-replay');
    const claim: ClaimInput = {
      episodeId: 'ep-replay',
      text: 'The foxglove queue depth alarm fires at 500.',
      subjectEntityId: 'entity-foxglove-queue',
      aspectNorm: aspect('alarm threshold'),
      keyedClose: { mode: 'close', relatednessFloor: FAMILY_FLOOR },
    };
    const first = await writeClaim(claim);

    const replay = await writeClaim(claim);

    expect(replay.node.id).toBe(first.node.id);
    expect(replay.created).toBe(false);
    expect(replay.keyedClose?.closedIds).toEqual([]);
    expect(await isClosed(first.node.id)).toBe(false);
    expect(await supersedingNodeIds(harness.driver, first.node.id)).toEqual([]);
  });

  /**
   * The family cut around a keyed close, which runs under the `close` mode by construction. All
   * three siblings name the subject in their own text and carry the same vector, so containment
   * plus relatedness would have taken every one of them. Under this mode the key separates them:
   * the sibling asserting a second attribute of the same repository is not a candidate at all,
   * and the sibling with no key of its own is matched the way it always was.
   */
  it('under the close mode, holds a differently keyed sibling and takes an unkeyed one', async () => {
    const seeded = await seedFamily('write-close', 'Ravel repository', {
      mode: 'close',
      relatednessFloor: FAMILY_FLOOR,
    });

    const family = seeded.correction.keyedClose?.families[0];
    expect(family?.siblings.map((sibling) => sibling.id)).toEqual([seeded.unkeyed.node.id]);
    expect(family?.siblings.map((sibling) => sibling.keyed)).toEqual([false]);
    expect(family?.heldSiblings).toEqual([]);
    expect([...(seeded.correction.keyedClose?.closedIds ?? [])].sort()).toEqual(
      [seeded.prior.node.id, seeded.unkeyed.node.id].sort(),
    );
    expect(await isClosed(seeded.otherAspect.node.id)).toBe(false);
    expect(await supersedingNodeIds(harness.driver, seeded.otherAspect.node.id)).toEqual([]);
  });

  /**
   * The same three siblings closed through the family path an applied proposal runs, where the
   * mode is a value rather than a branch that has already been taken.
   *
   * Under `judge` an aspect slug is not yet reliable enough to exclude anything: extraction keys
   * both halves of a correction rarely, and the slug drifts between observations, so a sibling
   * the name test and the floor admit closes and no stale sentence stays current. Under `close`
   * that same sibling is held, which is the cut a deployment arms once its slugs measure
   * reliable. Nothing but the mode differs between the two halves.
   */
  it('takes a differently keyed sibling under the judge mode and holds it under close', async () => {
    const judged = await seedFamily('apply-judge', 'Sandpiper repository');

    const closedUnderJudge = await supersedeSubjectFamily(harness.driver, {
      claimId: judged.prior.node.id,
      newId: judged.correction.node.id,
      keyedCloseMode: 'judge',
      relatednessFloor: FAMILY_FLOOR,
      now: NOW,
      validUntil: OCCURRED_AT,
    });

    expect([...closedUnderJudge.siblings.map((sibling) => sibling.id)].sort()).toEqual(
      [judged.otherAspect.node.id, judged.unkeyed.node.id].sort(),
    );
    // Neither sibling was admitted on a key: one has none, and the other's disagrees.
    expect(closedUnderJudge.siblings.map((sibling) => sibling.keyed)).toEqual([false, false]);
    expect(closedUnderJudge.heldSiblings).toEqual([]);
    expect(await isClosed(judged.otherAspect.node.id)).toBe(true);
    expect(await isClosed(judged.unkeyed.node.id)).toBe(true);

    const held = await seedFamily('apply-close', 'Thistledown repository');

    const closedUnderClose = await supersedeSubjectFamily(harness.driver, {
      claimId: held.prior.node.id,
      newId: held.correction.node.id,
      keyedCloseMode: 'close',
      relatednessFloor: FAMILY_FLOOR,
      now: NOW,
      validUntil: OCCURRED_AT,
    });

    expect(closedUnderClose.siblings.map((sibling) => sibling.id)).toEqual([held.unkeyed.node.id]);
    expect(closedUnderClose.heldSiblings).toEqual([]);
    expect(await isClosed(held.unkeyed.node.id)).toBe(true);
    expect(await isClosed(held.otherAspect.node.id)).toBe(false);
    expect(await supersedingNodeIds(harness.driver, held.otherAspect.node.id)).toEqual([]);
  });

  it('retires an entity gloss that restates the claim the key closed', async () => {
    await seedEpisode('ep-gloss-old');
    await seedEpisode('ep-gloss-new');
    const pipeline = await seedEntity(
      'entity-quillon-pipeline',
      'Quillon ingest pipeline',
      'The Quillon ingest pipeline is owned by Marisol Vance.',
    );
    const owner = await seedEntity('entity-marisol-vance', 'Marisol Vance');
    await mention('ep-gloss-old', pipeline);
    await mention('ep-gloss-old', owner);
    const key = { subjectEntityId: pipeline, aspectNorm: aspect('owner') };
    const prior = await writeClaim({
      episodeId: 'ep-gloss-old',
      text: 'The Quillon ingest pipeline is owned by Marisol Vance.',
      ...key,
    });

    const correction = await writeClaim({
      episodeId: 'ep-gloss-new',
      text: 'The Quillon ingest pipeline is owned by Tobias Reyes.',
      ...key,
      keyedClose: { mode: 'close', relatednessFloor: FAMILY_FLOOR },
    });

    expect(correction.keyedClose?.closedIds).toEqual([prior.node.id]);
    expect(
      correction.keyedClose?.families.flatMap((family) =>
        family.retiredGlosses.map((subject) => subject.entityId),
      ),
    ).toEqual([pipeline]);
    const retired = await nodeProperties(harness.driver, pipeline);
    expect(retired[MEMORY_PROPERTIES.text]).toBeUndefined();
    expect(retired[PRIOR_DESCRIPTIONS_PROPERTY]).toEqual([
      'The Quillon ingest pipeline is owned by Marisol Vance.',
    ]);
    // The entity itself is untouched by the retirement: the name every later mention resolves
    // through is still there.
    expect(retired[ENTITY_NAME_NORM_PROPERTY]).toBe(foldName('Quillon ingest pipeline'));
    expect(await isClosed(pipeline)).toBe(false);
  });
});
