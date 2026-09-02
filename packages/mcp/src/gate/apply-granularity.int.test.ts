import {
  applySupersessionProposal,
  DEFAULTS,
  fetchNodeEdges,
  findEpisodeCognitiveNodes,
  listSupersessionProposals,
  recordSupersessionProposal,
  type SupersessionProposal,
} from '@aion/core';
import { SUPERSEDES_TYPE } from '@aion/core/infrastructure/graph/relationships.js';
import {
  findClaimSubjects,
  SUBJECT_PROPAGATION_METHOD,
} from '@aion/core/infrastructure/graph/subject-family.js';
import { nodeProperties } from '@aion/core/infrastructure/graph/test-support/graph-queries.fixture.js';
import type { MemoryPackItem } from '@aion/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OWNERSHIP_CORRECTION } from './apply-granularity.fixture.js';
import { GateSubstrate, waitFor } from './gate-substrate.fixture.js';

/**
 * What an applied correction does to what recall answers.
 *
 * The measured failure this gates: a correct proposal applied at claim level closed the judged
 * claim and left the answer unchanged, because the stale ownership also lived in a sibling
 * extracted from the same observation. The default apply now closes the siblings that name the
 * judged claim's subject, and the gate is the pack: the corrected owner has to lead it, and
 * nothing still claiming the old owner may be stamped current.
 *
 * The entity description is the residual the apply cannot close. Entities are identity anchors
 * that outlive every episode naming them, so this checks the apply reports the gloss rather
 * than pretending it reached it.
 */

const BASELINE_AT = new Date('2026-07-01T09:00:00.000Z');
const CORRECTION_AT = new Date('2026-07-02T09:00:00.000Z');
const APPLIED_AT = new Date('2026-07-03T09:00:00.000Z');
const READ_SESSION = 'gate-granularity-read';

const ENRICH_DEADLINE_MS = 900_000;

const substrate = new GateSubstrate('granularity');

let baselineEpisodeId = '';
let correctionEpisodeId = '';
let baselineNodeIds: readonly string[] = [];
/** What the baseline episode actually yielded, label and text, since the family cut starts here. */
let baselineClaims: readonly string[] = [];
let correctionNodeIds: readonly string[] = [];
let proposal: SupersessionProposal | undefined;
let proposalWasJudged = false;

async function enrich(episodeId: string, label: string): Promise<void> {
  const worker = substrate.worker();
  await worker.start();
  await waitFor(label, ENRICH_DEADLINE_MS, () => Promise.resolve(substrate.enriched(episodeId)));
  await worker.stop();
}

function names(item: MemoryPackItem, needle: string): boolean {
  return item.content.toLowerCase().includes(needle.toLowerCase());
}

function describeItems(items: readonly MemoryPackItem[]): string {
  return items
    .slice(0, 6)
    .map((item) => `[${String(item.rank)} ${item.currency}] ${item.content.slice(0, 64)}`)
    .join(' | ');
}

/**
 * The judge is a model, so whether it fires on this pair is a measurement rather than a
 * guarantee. Granularity is what this file gates, so a run where detection missed builds the
 * row from the nodes the pipeline did extract and says so in the log.
 */
async function reviewRow(): Promise<SupersessionProposal | undefined> {
  const judged = listSupersessionProposals(substrate.db).find(
    (row) => baselineNodeIds.includes(row.oldId) && correctionNodeIds.includes(row.newId),
  );
  if (judged !== undefined) {
    proposalWasJudged = true;
    return judged;
  }

  const stale = await staleOwnershipNode();
  const corrected = await correctedOwnershipNode();
  if (stale === undefined || corrected === undefined) {
    return undefined;
  }
  const id = recordSupersessionProposal(substrate.db, {
    oldId: stale,
    newId: corrected,
    confidence: 1,
    episodeId: correctionEpisodeId,
    rationale: 'ownership of the subject',
    createdAt: '2026-08-29T12:00:00.000Z',
  });
  return listSupersessionProposals(substrate.db).find((row) => row.id === id);
}

const UNREADABLE_BAND =
  'unreadable, because the enrichment made this close: the cosine each sibling was judged on is ' +
  'taken inside the apply and never stored';

type AppliedResult = Awaited<ReturnType<typeof applySupersessionProposal>>;

/**
 * The close this file measures, whoever made it. Under the shipped `unanimous` supersede mode
 * the two-pass judge applies its own proposal during enrichment, so on a run where the second
 * pass agrees the close has already landed and the row is resolved; a veto leaves the row open
 * and this file makes the close itself. Both answer the same questions.
 */
type AppliedClose = Pick<AppliedResult, 'closedIds' | 'subjects' | 'openGlosses'> & {
  /** `family` when the lineage carries a propagated sibling, which no other scope writes. */
  readonly scope: string;
  /**
   * The cosine each sibling was judged on, present only when this file made the close. The
   * reading is taken inside the apply against the two claims' vectors and never stored, and the
   * sibling read that would recompute it takes open nodes only, so a close read back after the
   * fact has no answer for the half it closed.
   */
  readonly band?: string;
};

/**
 * The band the relatedness floor sits in, from the run that reads it: every sibling the subject
 * match found, closed or held, with the cosine it was judged on. This is the measurement the
 * floor is derived from, so it belongs in the run's own output.
 */
function familyBand(applied: AppliedResult): string {
  return [...applied.siblings, ...applied.heldSiblings]
    .map(
      (sibling) =>
        `${(sibling.relatedness ?? Number.NaN).toFixed(3)} ${
          applied.siblings.includes(sibling) ? 'closed' : 'held'
        } "${sibling.text.slice(0, 60)}"`,
    )
    .join('\n  ');
}

function closedScope(closedTheClaim: boolean, propagated: number): string {
  if (!closedTheClaim) {
    return 'nothing closed';
  }
  if (propagated > 0) {
    return 'family';
  }
  return 'claim';
}

/**
 * The enrichment's own close, read back off the lineage it wrote. What the apply returned went
 * with the tick that made it and the row records only that the pair was decided, so the family
 * is recovered from `(new)-[:SUPERSEDES]->(old)`: the judged claim carries the apply's own
 * provenance, and every sibling carries `SUBJECT_PROPAGATION_METHOD`, which only a family close
 * writes. A claim close touches the judged claim alone and an episode close records the
 * correcting episode as the successor, so the propagated edge is what separates the three.
 *
 * Re-applying instead would measure something else: the sibling read takes only open nodes, so a
 * second apply over a family that is already closed comes back with the judged claim alone.
 */
async function readAppliedClose(row: SupersessionProposal): Promise<AppliedClose> {
  const lineage = (await fetchNodeEdges(substrate.driver, row.newId)).filter(
    (edge) => edge.type === SUPERSEDES_TYPE && edge.outgoing && edge.reopenedAt === undefined,
  );
  const closedTheClaim = lineage.some((edge) => edge.otherId === row.oldId);
  const propagated = lineage.filter(
    (edge) => edge.otherId !== row.oldId && edge.provenance.includes(SUBJECT_PROPAGATION_METHOD),
  );
  // The same read the apply matched its family on, over inputs the close does not move: it
  // stamps `valid_until` on claims and clears the text of a gloss it retired, and neither the
  // source episode nor the entities the subject test reads are closed by it. A retired gloss
  // leaves no text behind, so the subjects that still carry one are the glosses left open.
  const subjects = await findClaimSubjects(substrate.driver, row.oldId);
  return {
    scope: closedScope(closedTheClaim, propagated.length),
    closedIds: closedTheClaim ? [row.oldId, ...propagated.map((edge) => edge.otherId)] : [],
    subjects: subjects.map((subject) => subject.name),
    openGlosses: subjects.filter((subject) => subject.gloss !== undefined),
  };
}

/**
 * The gate's one close, taken from whichever pass made it. A resolved row is one the enrichment
 * already applied, and applying it again would throw; an open row is the veto path, where this
 * file makes the close itself with the shipped knobs.
 */
async function closeUnderReview(row: SupersessionProposal | undefined): Promise<AppliedClose> {
  if (row === undefined) {
    throw new Error('no review row to close');
  }
  if (row.resolvedAt !== null) {
    return readAppliedClose(row);
  }
  const applied = await applySupersessionProposal(substrate.driver, substrate.db, {
    id: row.id,
    relatednessFloor: DEFAULTS.reflection.supersedeFamilyRelatednessFloor,
    // The shipped mode, so the gate measures the cut a deployment actually gets.
    keyedCloseMode: DEFAULTS.reflection.keyedCloseMode,
    now: APPLIED_AT,
  });
  return { ...applied, band: familyBand(applied) };
}

async function nodeText(id: string): Promise<string> {
  const { text } = await nodeProperties(substrate.driver, id);
  return (typeof text === 'string' ? text : '').toLowerCase();
}

async function staleOwnershipNode(): Promise<string | undefined> {
  for (const id of baselineNodeIds) {
    const text = await nodeText(id);
    if (
      text.includes(OWNERSHIP_CORRECTION.staleOwner.toLowerCase()) &&
      text.includes(OWNERSHIP_CORRECTION.subject.toLowerCase())
    ) {
      return id;
    }
  }
  return undefined;
}

async function correctedOwnershipNode(): Promise<string | undefined> {
  for (const id of correctionNodeIds) {
    const text = await nodeText(id);
    if (text.includes(OWNERSHIP_CORRECTION.currentOwner.toLowerCase())) {
      return id;
    }
  }
  return correctionNodeIds[0];
}

beforeAll(async () => {
  await substrate.open();

  const baseline = await substrate.store(
    {
      summary: OWNERSHIP_CORRECTION.baselineSummary,
      observations: [...OWNERSHIP_CORRECTION.baseline],
    },
    { identity: OWNERSHIP_CORRECTION.session, now: BASELINE_AT },
  );
  baselineEpisodeId = baseline.episode_id;
  await enrich(baselineEpisodeId, 'the ownership baseline to enrich');

  const correction = await substrate.store(
    {
      summary: OWNERSHIP_CORRECTION.correctionSummary,
      observations: [...OWNERSHIP_CORRECTION.correction],
    },
    { identity: OWNERSHIP_CORRECTION.session, now: CORRECTION_AT },
  );
  correctionEpisodeId = correction.episode_id;
  await enrich(correctionEpisodeId, 'the ownership correction to enrich');

  const baseline0 = await findEpisodeCognitiveNodes(substrate.driver, baselineEpisodeId);
  baselineClaims = baseline0.map((node) => `${node.label} "${node.text.slice(0, 70)}"`);
  baselineNodeIds = baseline0.map((node) => node.id);
  correctionNodeIds = (await findEpisodeCognitiveNodes(substrate.driver, correctionEpisodeId)).map(
    (node) => node.id,
  );
  proposal = await reviewRow();
}, 2_400_000);

afterAll(async () => {
  await substrate.close();
});

describe('a correction applied at the default granularity', () => {
  it('records how the stale ownership is spread before anything is applied', async () => {
    const before = await substrate.recall(OWNERSHIP_CORRECTION.query, {
      identity: READ_SESSION,
      now: APPLIED_AT,
    });
    const stale = before.items.filter((item) => names(item, OWNERSHIP_CORRECTION.staleOwner));

    console.log(
      `before apply: ${String(before.items.length)} items, ` +
        `${String(stale.length)} naming ${OWNERSHIP_CORRECTION.staleOwner}, ` +
        `${String(baselineNodeIds.length)} baseline claims; ${describeItems(before.items)}`,
    );
    console.log(`baseline claims: ${baselineClaims.join(' | ')}`);
    console.log(
      `review row: ${proposal === undefined ? 'none' : proposal.id}, ${
        proposalWasJudged
          ? 'proposed by the judge'
          : 'built from the extracted claims after the judge missed the pair'
      }`,
    );

    expect(before.items.length).toBeGreaterThan(0);
    // The failure being gated only exists when the old value is spread across more than the
    // one judged claim, so a run that produced a single carrier is not measuring it.
    expect(stale.length).toBeGreaterThan(1);
  }, 300_000);

  it('closes the siblings naming the subject and reports the gloss it cannot close', async () => {
    expect(proposal).toBeDefined();
    const applied = await closeUnderReview(proposal);

    console.log(
      `close made by ${applied.band === undefined ? 'the enrichment' : 'this file'}: ` +
        `applied ${applied.scope}, closed ${String(applied.closedIds.length)} node(s) on subjects ` +
        `[${applied.subjects.join(', ')}], ${String(applied.openGlosses.length)} gloss(es) left open ` +
        `(${applied.openGlosses.map((gloss) => gloss.name).join(', ')})`,
    );
    const band = applied.band ?? UNREADABLE_BAND;
    console.log(
      `family band at floor ${String(DEFAULTS.reflection.supersedeFamilyRelatednessFloor)}: ${band}`,
    );

    expect(applied.scope).toBe('family');
    // The judged claim alone was the measured failure; the point of the default is that its
    // siblings on the same subject go with it.
    expect(applied.closedIds.length).toBeGreaterThan(1);
    expect(applied.subjects.length).toBeGreaterThan(0);
    for (const id of applied.closedIds) {
      const properties = await nodeProperties(substrate.driver, id);
      expect(properties.valid_until ?? undefined).toBeDefined();
    }
    // The source episode and its unrelated claims are not part of a subject family: closing
    // the observation is what `--episode` is for.
    const episode = await nodeProperties(substrate.driver, baselineEpisodeId);
    expect(episode.valid_until ?? undefined).toBeUndefined();
  }, 300_000);

  /**
   * Facts and episodes answer differently after a correction, so they are read apart. A fact
   * asserts the state of the world and may not go on asserting the old one as current. An
   * episode records that something was observed on a day, which stays true after the thing it
   * observed changes; closing those is what `--episode` is for, and doing it by default would
   * take every true record in the observation with the one claim that stopped holding.
   */
  it('leaves no fact still claiming the old owner as current', async () => {
    const after = await substrate.recall(OWNERSHIP_CORRECTION.query, {
      identity: READ_SESSION,
      now: APPLIED_AT,
    });
    // A correcting claim names the old owner to deny it, so a claim from the correction
    // episode itself is not a stale assertion of the old owner even when it names them.
    const stale = (item: MemoryPackItem): boolean =>
      names(item, OWNERSHIP_CORRECTION.staleOwner) &&
      !names(item, OWNERSHIP_CORRECTION.currentOwner) &&
      !correctionNodeIds.includes(item.id);

    const current = after.items.find((item) => names(item, OWNERSHIP_CORRECTION.currentOwner));
    const staleFacts = (after.pack.facts ?? []).filter(stale);
    const staleRecords = after.items.filter((item) => stale(item) && !staleFacts.includes(item));

    console.log(
      `after apply: current owner at rank ${String(current?.rank ?? -1)}, ` +
        `${String(staleFacts.length)} stale fact(s) ` +
        `(${staleFacts.map((item) => `${String(item.rank)}:${item.currency}`).join(', ') || 'none'}), ` +
        `${String(staleRecords.length)} stale record(s) ` +
        `(${staleRecords.map((item) => `${String(item.rank)}:${item.currency}`).join(', ') || 'none'}); ${describeItems(
          after.items,
        )}`,
    );

    expect(current).toBeDefined();
    // A superseded memory is still served, with its lineage: currency-aware, not
    // currency-filtered. What it may not do is claim to be current, which is exactly what the
    // claim-level apply left three items doing.
    for (const item of staleFacts) {
      expect(item.currency).toBe('superseded');
      expect(item.superseded_by?.id).toBeDefined();
    }
    // The description that restated the closed claim is the one carrier with no lineage to
    // annotate, so the only honest outcome is that it stops being served at all.
    const glossText = `${OWNERSHIP_CORRECTION.staleOwner} (person)`;
    expect(after.items.some((item) => item.content.startsWith(glossText))).toBe(false);
  }, 300_000);
});
