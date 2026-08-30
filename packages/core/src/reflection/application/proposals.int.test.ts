import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applySupersessionProposal,
  dismissSupersessionProposal,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  PROPOSAL_APPLY_METHOD,
} from './proposals.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { BITEMPORAL_PROPERTIES, writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { writeCognitiveNode } from '../../infrastructure/graph/cognitive-queries.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { findSourceEpisodeId } from '../../infrastructure/graph/episode-supersession.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  findClaimSubjects,
  findSubjectSiblings,
} from '../../infrastructure/graph/subject-family.js';
import {
  nodeProperties,
  relationshipsByProvenance,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  getSupersessionProposal,
  recordSupersessionProposal,
} from '../../infrastructure/sqlite/supersession-proposals.js';

/**
 * The path a correction takes once a person agrees with the judge. Propose mode closes
 * nothing on its own, which is the point, so this is the only path that can make a stored
 * correction change what recall answers. Before it existed the proposal table was write-only
 * and the correction battery could only be passed by a test calling the graph primitive
 * directly.
 */

const EMBED_DIMENSION = 8;
const FLOOR = DEFAULTS.reflection.supersedeFamilyRelatednessFloor;
const NOW = new Date('2026-08-29T12:00:00.000Z');

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;

async function seedEpisode(id: string, text: string): Promise<void> {
  await writeStampedNode(harness.driver, {
    label: 'Episode',
    id,
    now: NOW,
    properties: { text, session_id: 'proposal-session' },
  });
}

/**
 * An entity the episode named, with the frozen description the extractor writes once. The
 * subject family is matched on these, so a test without them measures the degraded path.
 */
async function mention(
  episodeId: string,
  name: string,
  type: string,
  description?: string,
): Promise<string> {
  const id = `entity-${name.toLowerCase().replace(/\s+/g, '-')}`;
  await writeStampedNode(harness.driver, {
    label: 'Entity',
    id,
    now: NOW,
    properties: {
      name,
      name_norm: name.toLowerCase(),
      type,
      text: `${name} (${type}): ${description ?? 'as first described.'}`,
    },
  });
  await upsertEdge(harness.driver, {
    type: 'MENTIONS',
    sourceId: episodeId,
    targetId: id,
    strength: 1,
    confidence: 1,
    signals: ['test'],
    provenance: ['test'],
    now: NOW,
  });
  return id;
}

/**
 * Hand-written unit vectors rather than a live embed: what the family gate turns on is the
 * cosine between two claims, so a test that asserts where the line falls has to place the
 * claims either side of it exactly. The first component carries the relation, the second
 * carries everything else, so a claim about the same relation sits near `RELATION_AXIS` and a
 * claim about a different one sits near the orthogonal axis.
 */
const RELATION_AXIS = [1, 0, 0, 0, 0, 0, 0, 0];

function offAxis(cosine: number): number[] {
  return [cosine, Math.sqrt(1 - cosine * cosine), 0, 0, 0, 0, 0, 0];
}

async function seedClaim(
  episodeId: string,
  text: string,
  contentVector?: readonly number[],
): Promise<string> {
  const result = await writeCognitiveNode(harness.driver, {
    episodeId,
    label: 'Concept',
    text,
    now: NOW,
    ...(contentVector === undefined ? {} : { contentVector: [...contentVector] }),
  });
  return result.node.id;
}

async function isClosed(id: string): Promise<boolean> {
  const properties = await nodeProperties(harness.driver, id);
  return properties[BITEMPORAL_PROPERTIES.validUntil] !== undefined;
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-proposal-apply-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('applying a supersession proposal', () => {
  it('closes the judged claim under --claim-only, and records the review as its own provenance', async () => {
    await seedEpisode('ep-poll-1', 'The Zephyr ingest worker polls every 45 seconds.');
    await seedEpisode(
      'ep-poll-2',
      'We changed the Zephyr ingest worker poll interval to 5 seconds.',
    );
    const stale = await seedClaim('ep-poll-1', 'Zephyr ingest polls every 45 seconds');
    const corrected = await seedClaim('ep-poll-2', 'Zephyr ingest polls every 5 seconds');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      rationale: 'poll interval',
      episodeId: 'ep-poll-2',
    });

    expect(await isClosed(stale)).toBe(false);

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      scope: 'claim',
      relatednessFloor: FLOOR,
      now: NOW,
    });

    expect(applied.closedIds).toEqual([stale]);
    expect(applied.supersededBy).toBe(corrected);
    expect(await isClosed(stale)).toBe(true);
    expect(await isClosed(corrected)).toBe(false);
    // A human review is its own provenance: lineage has to distinguish what a person applied
    // from what the judge would have applied on its own, or the posture change is unreadable.
    const reviewed = await relationshipsByProvenance(harness.driver, PROPOSAL_APPLY_METHOD);
    expect(reviewed).toContainEqual(
      expect.objectContaining({ sourceId: corrected, targetId: stale }),
    );
    expect(getSupersessionProposal(db, proposalId)?.resolvedAt).toEqual(expect.any(String));
  }, 120_000);

  /**
   * The default, and where it stops. A claim's siblings were extracted from the same
   * observation, so closing the claim alone leaves the ones restating it answering as current,
   * which is the compounding half of "a correction does not change what recall answers". But
   * naming the same subject is not the same as being about the same thing: a sibling that says
   * something else about the exporter is still true after the publish target moved, and
   * closing it because it said the name would take a fact nothing contradicted.
   */
  it('closes the siblings the correction is about and holds the rest open', async () => {
    await seedEpisode(
      'ep-fanout-1',
      'The Kestrel exporter publishes to Kafka on the primary broker.',
    );
    await seedEpisode('ep-fanout-2', 'The Kestrel exporter publishes to Pub/Sub now.');
    await mention('ep-fanout-1', 'Kestrel exporter', 'service');
    await mention('ep-fanout-1', 'Alderwood loader', 'service');
    const stale = await seedClaim(
      'ep-fanout-1',
      'the Kestrel exporter publishes to Kafka',
      RELATION_AXIS,
    );
    const restating = await seedClaim(
      'ep-fanout-1',
      'the Kestrel exporter publishes to Kafka on the primary broker',
      offAxis(0.9),
    );
    const otherRelation = await seedClaim(
      'ep-fanout-1',
      'the Kestrel exporter batches every 30 seconds',
      offAxis(0.2),
    );
    const otherSubject = await seedClaim(
      'ep-fanout-1',
      'the Alderwood loader reads from Kafka',
      offAxis(0.5),
    );
    const corrected = await seedClaim(
      'ep-fanout-2',
      'the Kestrel exporter publishes to Pub/Sub',
      offAxis(0.8),
    );
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-fanout-2',
    });

    // The same read the apply runs, exposed so a caller can show what a close would take
    // before taking it. Both same-subject siblings are candidates; the reading decides.
    const preview = await findSubjectSiblings(harness.driver, stale);
    expect(preview.map((sibling) => sibling.id).sort()).toEqual([otherRelation, restating].sort());
    expect(preview.find((sibling) => sibling.id === restating)?.relatedness).toBeCloseTo(0.9, 2);
    expect(preview.find((sibling) => sibling.id === otherRelation)?.relatedness).toBeCloseTo(
      0.2,
      2,
    );
    // The episode mentions both services; only the one the claim itself names is a subject.
    const subjects = await findClaimSubjects(harness.driver, stale);
    expect(subjects.map((subject) => subject.name)).toEqual(['Kestrel exporter']);

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      relatednessFloor: FLOOR,
      now: NOW,
    });

    expect(applied.scope).toBe('family');
    expect(applied.closedIds).toEqual([stale, restating]);
    expect(applied.subjects).toContain('Kestrel exporter');
    expect(await isClosed(restating)).toBe(true);
    // Still true after the publish target moved, and still answering.
    expect(await isClosed(otherRelation)).toBe(false);
    expect(await isClosed(otherSubject)).toBe(false);
    expect(await isClosed('ep-fanout-1')).toBe(false);
    expect(applied.siblings.map((sibling) => sibling.id)).toEqual([restating]);
    // Named but untouched, and reported so a person who meant to take the whole observation
    // can see what the narrower cut left.
    expect(applied.heldSiblings.map((sibling) => sibling.id)).toEqual([otherRelation]);
    // A description that asserts something the correction did not touch stands, and the apply
    // names it rather than leaving the operator to guess what else carries the subject.
    expect(applied.openGlosses.map((gloss) => gloss.name)).toContain('Kestrel exporter');
    expect(applied.retiredGlosses).toEqual([]);
  }, 120_000);

  /**
   * The carrier that made the measured correction change nothing. A description written the
   * first time the pipeline saw the name restates the relation the correction just closed, and
   * it is served as a current fact with no lineage because entities carry none. Clearing the
   * sentence leaves the entity, its name and every edge through it exactly where they were,
   * and the wording itself moves to `prior_descriptions` rather than being dropped: nothing in
   * this substrate is hard-deleted, and a retirement is not the place to start.
   */
  it('retires a description that restates the closed claim, and keeps the entity', async () => {
    await seedEpisode('ep-owner-1', 'Dmitri Volkov owns the Quillon pipeline.');
    await seedEpisode('ep-owner-2', 'Anneke Vos owns the Quillon pipeline now.');
    const person = await mention(
      'ep-owner-1',
      'Dmitri Volkov',
      'person',
      'owns the Quillon pipeline',
    );
    await mention(
      'ep-owner-1',
      'Quillon pipeline',
      'project',
      'moves claim files into the warehouse',
    );
    const stale = await seedClaim('ep-owner-1', 'Dmitri Volkov owns the Quillon pipeline');
    const corrected = await seedClaim('ep-owner-2', 'Anneke Vos owns the Quillon pipeline');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-owner-2',
    });

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      relatednessFloor: FLOOR,
      now: NOW,
    });

    expect(applied.retiredGlosses.map((gloss) => gloss.name)).toEqual(['Dmitri Volkov']);
    // The definition of the thing that changed hands says nothing about who owns it, so it
    // survives a correction about ownership.
    expect(applied.openGlosses.map((gloss) => gloss.name)).toEqual(['Quillon pipeline']);
    const entity = await nodeProperties(harness.driver, person);
    expect(entity.text ?? undefined).toBeUndefined();
    expect(entity.name).toBe('Dmitri Volkov');
    expect(entity[BITEMPORAL_PROPERTIES.validUntil] ?? undefined).toBeUndefined();
    // The sentence is recoverable, and stamped with when it stopped being served.
    expect(entity.prior_descriptions).toEqual([
      'Dmitri Volkov (person): owns the Quillon pipeline',
    ]);
    expect(entity.description_retired_at).toBeTruthy();
    // The baseline resets, so the mentions that arrive next qualify the entity for a fresh
    // description instead of being measured against a count taken for the retired one.
    expect(entity.description_mention_count).toBe(0);
  }, 120_000);

  /**
   * The narrow escape has to stay narrow: with the subject family as the default, an operator
   * correcting one wrong sentence inside a good observation needs a way to leave the rest.
   */
  it('leaves a same-subject sibling open under --claim-only', async () => {
    await seedEpisode('ep-narrow-1', 'The Bramble worker runs two replicas and logs to stdout.');
    await seedEpisode('ep-narrow-2', 'The Bramble worker runs eight replicas.');
    await mention('ep-narrow-1', 'Bramble worker', 'service');
    const stale = await seedClaim('ep-narrow-1', 'the Bramble worker runs two replicas');
    const sibling = await seedClaim('ep-narrow-1', 'the Bramble worker logs to stdout');
    const corrected = await seedClaim('ep-narrow-2', 'the Bramble worker runs eight replicas');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-narrow-2',
    });

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      scope: 'claim',
      relatednessFloor: FLOOR,
      now: NOW,
    });

    expect(applied.closedIds).toEqual([stale]);
    expect(await isClosed(sibling)).toBe(false);
  }, 120_000);

  /** With no entity naming the subject there is nothing to widen on, so the family is the claim. */
  it('degrades to the judged claim when nothing names a subject', async () => {
    await seedEpisode('ep-bare-1', 'first');
    await seedEpisode('ep-bare-2', 'second');
    const stale = await seedClaim('ep-bare-1', 'the first claim');
    const sibling = await seedClaim('ep-bare-1', 'another first-episode claim');
    const corrected = await seedClaim('ep-bare-2', 'the second claim');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-bare-2',
    });

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      relatednessFloor: FLOOR,
      now: NOW,
    });

    expect(applied.closedIds).toEqual([stale]);
    expect(applied.subjects).toEqual([]);
    expect(await isClosed(sibling)).toBe(false);
  }, 120_000);

  /**
   * The widest blade, and the one that takes definitions and historical records with it. It
   * stays reachable because an observation that was wrong end to end is a real case.
   */
  it('closes the source episode and its derived family under --episode', async () => {
    await seedEpisode('ep-region-1', 'The billing service deploys to AWS us-east-1.');
    await seedEpisode('ep-region-2', 'The billing service has been deployed to Fly.io.');
    const stale = await seedClaim('ep-region-1', 'billing deploys to AWS us-east-1');
    const sibling = await seedClaim('ep-region-1', 'us-east-1 is the billing region');
    const corrected = await seedClaim('ep-region-2', 'billing deploys to Fly.io');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-region-2',
    });

    expect(await findSourceEpisodeId(harness.driver, stale)).toBe('ep-region-1');

    const applied = await applySupersessionProposal(harness.driver, db, {
      id: proposalId,
      scope: 'episode',
      relatednessFloor: FLOOR,
      now: NOW,
    });

    expect(applied.closedIds).toContain('ep-region-1');
    expect(applied.closedIds).toContain(stale);
    expect(applied.closedIds).toContain(sibling);
    expect(await isClosed(sibling)).toBe(true);
    expect(await isClosed(corrected)).toBe(false);
  }, 120_000);

  it('refuses an unknown id and a proposal someone already decided, rather than writing twice', async () => {
    await seedEpisode('ep-once-1', 'first');
    await seedEpisode('ep-once-2', 'second');
    const stale = await seedClaim('ep-once-1', 'the first claim');
    const corrected = await seedClaim('ep-once-2', 'the second claim');
    const proposalId = recordSupersessionProposal(db, {
      oldId: stale,
      newId: corrected,
      confidence: 1,
      episodeId: 'ep-once-2',
    });
    dismissSupersessionProposal(db, proposalId, NOW);

    await expect(
      applySupersessionProposal(harness.driver, db, {
        id: proposalId,
        relatednessFloor: FLOOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ProposalAlreadyResolvedError);
    await expect(
      applySupersessionProposal(harness.driver, db, {
        id: 'no-such-proposal',
        relatednessFloor: FLOOR,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ProposalNotFoundError);
    // Dismissed means the claim stands: nothing was closed on the way to refusing.
    expect(await isClosed(stale)).toBe(false);
  }, 120_000);
});
