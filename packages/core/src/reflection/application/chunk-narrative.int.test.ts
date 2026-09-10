import { expect, it } from 'vitest';

import { publishChunkNarrative, sealSessionChunk } from './chunk-narrative.js';
import {
  NOW,
  accept,
  acceptCorrection,
  battery,
  body,
  chunks,
  driver,
  forget,
  prompts,
  resetPrompts,
  retireCorrection,
  sealAndPublish,
  sessionNodeOf,
  store,
  unforget,
} from './test-support/chunk-lifecycle.fixture.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { SUPERSEDES_TYPE } from '../../infrastructure/graph/relationships.js';
import {
  countEdges,
  countOpenEdgesInto,
  nodeProperties,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { listChunkMembers, readChunk } from '../../infrastructure/sqlite/chunk-manifest.js';
import {
  readCitationsFrom,
  revisionsDependingOn,
} from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  readNarrativeRevision,
  readPublishedHead,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { CHUNK_BOUNDARY_POLICY } from '../domain/chunk-boundary.js';

/**
 * The C2 steady-state lifecycle: what seals, what a revision submits, and what refuses.
 *
 * The provider is scripted and it records the exact string it was handed, so every claim about
 * what reached the model is asserted on that string rather than on a coverage number. Nothing in
 * this file's import graph constructs a model client: the intake provider rejects both calls, so
 * an accidental generation fails the run instead of passing quietly.
 */

it('seals a session tail at its close and publishes one revision over exactly its members', async () => {
  const first = await accept('session-basic', 'alpha');
  const second = await accept('session-basic', 'beta');
  const chunkId = await sealAndPublish('session-basic');
  battery.basicChunkId = chunkId;
  expect(listChunkMembers(store.db, chunkId)).toEqual([first, second]);

  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('published');
  if (report.status !== 'published') {
    return;
  }
  expect(report.revisionNo).toBe(1);
  expect(report.gaps).toBe(0);

  // The submitted input carried both members' raw text, which is the claim a coverage number
  // cannot make on its own.
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(body('alpha'));
  expect(prompts[0]).toContain(body('beta'));

  const properties = await nodeProperties(driver, report.nodeId);
  expect(properties[NARRATIVE_PROPERTIES.family]).toBe('chunk');
  expect(properties[NARRATIVE_PROPERTIES.chunkId]).toBe(chunkId);
  expect(properties[NARRATIVE_PROPERTIES.coverage]).toBe(1);
  expect(await countEdges(driver, SUMMARIZED_BY_TYPE, first, report.nodeId)).toBe(1);
  expect(await countEdges(driver, DERIVES_FROM_TYPE, report.nodeId, sessionNodeOf(first))).toBe(1);

  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);
  expect(readChunk(store.db, chunkId)?.state).toBe('published');
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(head?.coverageGapsJson).toBe('[]');
  expect(
    readCitationsFrom(store.db, report.nodeId)
      .map((row) => row.targetId)
      .sort(),
  ).toEqual([first, second].sort());
  expect(revisionsDependingOn(store.db, first).length).toBeGreaterThan(0);
});

it('leaves a head whose dependency versions still read the same, and asks no model', async () => {
  const report = await publishChunkNarrative(chunks, battery.basicChunkId, { now: NOW });
  expect(report.status).toBe('skipped');
  expect(prompts).toEqual([]);
});

it('omits a forgotten member with its gap while its neighbours are submitted whole', async () => {
  const first = await accept('session-forget', 'gamma');
  const forgotten = await accept('session-forget', 'delta');
  const third = await accept('session-forget', 'epsilon');
  const chunkId = await sealAndPublish('session-forget');
  const initial = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(initial.status).toBe('published');
  const firstNode = initial.status === 'published' ? initial.nodeId : '';

  forget(forgotten, 'forget-delta');
  resetPrompts();
  const replacement = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(replacement.status).toBe('published');
  if (replacement.status !== 'published') {
    return;
  }
  expect(replacement.revisionNo).toBe(2);
  // The N1 collision, closed: a rewrite over the same membership is a new revision with an id of
  // its own rather than a second write onto the node it replaces.
  expect(replacement.nodeId).not.toBe(firstNode);

  // The forgotten member's content reached no model input, and the healthy neighbours' did.
  expect(prompts[0]).not.toContain(body('delta'));
  expect(prompts[0]).toContain(body('gamma'));
  expect(prompts[0]).toContain(body('epsilon'));

  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, chunkId);
  expect(JSON.parse(head?.coverageGapsJson ?? '[]')).toEqual([
    { reason: 'suppressed_member', sourceId: forgotten },
  ]);
  // Membership is frozen: the omitted member is still a member of this chunk.
  expect(listChunkMembers(store.db, chunkId)).toEqual([first, forgotten, third]);
  // The head it replaced stopped summarizing the session, and the new one does.
  expect(await countOpenEdgesInto(driver, SUMMARIZED_BY_TYPE, firstNode)).toBe(0);
  // Residency decides the edges, and suppression is not eviction: the omitted member is still
  // resident, so its structural edge is written exactly as the manifest records its membership.
  expect(await countOpenEdgesInto(driver, SUMMARIZED_BY_TYPE, replacement.nodeId)).toBe(3);
});

it('publishes nothing for a chunk whose every member is forgotten', async () => {
  const only = await accept('session-all-forgotten', 'zeta');
  const chunkId = await sealAndPublish('session-all-forgotten');
  forget(only, 'forget-zeta');
  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('blocked');
  if (report.status === 'blocked') {
    expect(report.reason).toBe('no_admissible_input');
  }
  expect(prompts).toEqual([]);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBeUndefined();
  const revision = readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, 1);
  expect(revision?.blockedReason).toBe('no_admissible_input');
});

it('blocks the whole revision when the correction it must reground on is suppressed', async () => {
  const member = await accept('session-correction', 'eta');
  const chunkId = await sealAndPublish('session-correction');
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');
  const corrector = await acceptCorrection('session-corrector', 'theta', member);

  forget(corrector, 'forget-theta');
  resetPrompts();
  const blocked = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(blocked.status).toBe('blocked');
  if (blocked.status === 'blocked') {
    expect(blocked.reason).toBe('required_transition_evidence_suppressed');
  }
  // No model was asked, and the head that stands is the one written before the correction.
  expect(prompts).toEqual([]);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, chunkId)).toBe(1);

  // Restored, the same correction is submitted beside the frozen membership.
  unforget(corrector, 'unforget-theta');
  const regrounded = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(regrounded.status).toBe('published');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain(body('theta'));
  expect(prompts[0]).toContain(body('eta'));
});

it('seals an oversized member alone and publishes the ranges it actually submitted', async () => {
  const only = await accept('session-oversized', 'iota');
  const policy = { ...CHUNK_BOUNDARY_POLICY, renderedInputAllowance: 200 };
  const sealed = await sealSessionChunk(chunks, 'session-oversized', {
    now: NOW,
    sessionClosing: true,
    policy,
  });
  expect(sealed.status).toBe('sealed');
  if (sealed.status !== 'sealed') {
    return;
  }
  expect(sealed.members).toEqual([only]);

  const report = await publishChunkNarrative(chunks, sealed.chunkId, { now: NOW, policy });
  expect(report.status).toBe('published');
  if (report.status !== 'published') {
    return;
  }
  expect(report.gaps).toBe(1);
  const head = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, sealed.chunkId);
  const gaps = JSON.parse(head?.coverageGapsJson ?? '[]') as {
    reason: string;
    sourceId: string;
    submitted: { address: string; start: number; end: number }[];
  }[];
  expect(gaps).toHaveLength(1);
  expect(gaps[0]?.reason).toBe('oversized_member');
  expect(gaps[0]?.sourceId).toBe(only);
  expect(gaps[0]?.submitted.length).toBeGreaterThan(0);

  const submitted = gaps[0]?.submitted.reduce((sum, range) => sum + (range.end - range.start), 0);
  expect(submitted).toBeLessThan(body('iota').length);
  const properties = await nodeProperties(driver, report.nodeId);
  expect(properties[NARRATIVE_PROPERTIES.coverage]).toBeLessThan(1);
  // The gapped revision never claims the whole member: only the submitted prefix reached it.
  expect(prompts[0]).not.toContain(body('iota'));
});

it('seals and publishes while the members still owe every downstream stage', async () => {
  const only = await accept('session-stalled', 'pi');
  const owed = (): number =>
    (
      store.db
        .prepare(
          `SELECT count(*) AS n FROM source_work
           WHERE source_id = ? AND state IN ('pending','retryable','transferred')`,
        )
        .get(only) as { n: number }
    ).n;
  const before = owed();
  expect(before).toBeGreaterThan(0);

  const chunkId = await sealAndPublish('session-stalled');
  const report = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(report.status).toBe('published');
  // Nothing completed while this ran: enrichment readiness is a different question from whether
  // the session may be written down, and the publication never consulted it.
  expect(owed()).toBe(before);
});

it('serves two chunks of one session at once, and supersedes neither across them', async () => {
  const early = await accept('session-two-chunks', 'tau');
  const first = await sealAndPublish('session-two-chunks');
  const firstPublished = await publishChunkNarrative(chunks, first, { now: NOW });
  expect(firstPublished.status).toBe('published');

  const later = await accept('session-two-chunks', 'upsilon');
  const second = await sealAndPublish('session-two-chunks');
  expect(second).not.toBe(first);
  expect(listChunkMembers(store.db, second)).toEqual([later]);
  const secondPublished = await publishChunkNarrative(chunks, second, { now: NOW });
  expect(secondPublished.status).toBe('published');
  if (firstPublished.status !== 'published' || secondPublished.status !== 'published') {
    return;
  }

  // Both heads stand. The whole-session path closes every open narrative of a session on each
  // write, which across a chunked session would retire the chunk before this one every time.
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, first)).toBe(1);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, second)).toBe(1);
  expect(await countOpenEdgesInto(driver, SUMMARIZED_BY_TYPE, firstPublished.nodeId)).toBe(1);
  expect(await countEdges(driver, SUMMARIZED_BY_TYPE, early, firstPublished.nodeId)).toBe(1);
  // No supersession between two chunks of one session, in either direction.
  expect(
    await countEdges(driver, SUPERSEDES_TYPE, secondPublished.nodeId, firstPublished.nodeId),
  ).toBe(0);
  expect(
    await countEdges(driver, SUPERSEDES_TYPE, firstPublished.nodeId, secondPublished.nodeId),
  ).toBe(0);
});

it('blocks only its own chunk when a frozen member stops being readable', async () => {
  await accept('session-blocked-neighbour', 'phi');
  const healthyChunk = await sealAndPublish('session-blocked-neighbour');
  const broken = await accept('session-blocked-neighbour', 'chi');
  const brokenChunk = await sealAndPublish('session-blocked-neighbour');
  expect(brokenChunk).not.toBe(healthyChunk);

  // Reversible: the recorded digest stops matching the archive the member is verified against.
  const digest = store.db
    .prepare('SELECT verified_content_digest AS d FROM source_records WHERE source_id = ?')
    .get(broken) as { d: string };
  store.db
    .prepare('UPDATE source_records SET verified_content_digest = ? WHERE source_id = ?')
    .run('digest-that-no-archive-row-hashes-to', broken);

  const blocked = await publishChunkNarrative(chunks, brokenChunk, { now: NOW });
  expect(blocked.status).toBe('blocked');
  if (blocked.status === 'blocked') {
    expect(blocked.reason).toBe('member_evidence_missing');
  }
  expect(listChunkMembers(store.db, brokenChunk)).toEqual([broken]);
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, brokenChunk)).toBeUndefined();

  // Its neighbour is untouched: it publishes on its own evidence.
  const neighbour = await publishChunkNarrative(chunks, healthyChunk, { now: NOW });
  expect(neighbour.status).toBe('published');
  expect(readPublishedHead(store.db, CHUNK_REVISION_FAMILY, healthyChunk)).toBe(1);

  store.db
    .prepare('UPDATE source_records SET verified_content_digest = ? WHERE source_id = ?')
    .run(digest.d, broken);
});

it('drops a retired correction from the required input and adds nothing for an unrelated change', async () => {
  const member = await accept('session-standing', 'psi');
  const chunkId = await sealAndPublish('session-standing');
  expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('published');

  const corrector = await acceptCorrection('session-standing-corrector', 'omega', member);
  const corrected = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(corrected.status).toBe('published');
  expect(prompts.at(-1)).toContain(body('omega'));

  // Withdrawn: the statement no longer stands, so the next revision does not submit it.
  retireCorrection(corrector, member, 'retire-omega');
  const withdrawn = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(withdrawn.status).toBe('published');
  expect(prompts.at(-1)).toContain(body('psi'));
  expect(prompts.at(-1)).not.toContain(body('omega'));

  // A correction of a source this chunk never held changes neither its head nor its input.
  const stranger = await accept('session-stranger', 'alpha2');
  await acceptCorrection('session-stranger-corrector', 'beta2', stranger);
  const asked = prompts.length;
  const unrelated = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(unrelated).toMatchObject({ status: 'skipped', reason: 'head_current' });
  expect(prompts).toHaveLength(asked);
});
