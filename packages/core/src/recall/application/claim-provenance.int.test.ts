import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BEFORE_SUPERSESSION,
  ClaimProvenanceSubstrate,
  CONFIRMATION_EVIDENCE,
  CONFIRMER,
  FAMILY_CLAIM_ID,
  FAMILY_CLAIM_TEXT,
  NEW_CLAIM_ID,
  OLD_CLAIM_ID,
  RECALLED_AT,
  ROOT_ID,
  TURN_ID,
} from './test-support/claim-provenance.fixture.js';
import { fetchNodeProvenance } from '../../infrastructure/graph/node-provenance.js';
import { knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';

/**
 * The source record a pack carries: a caller states where an experience came from and what it
 * corrects, and a later recall renders those statements as what they are. The historical reads
 * and the durable-reference handling are the two suites beside this one.
 */

const substrate = new ClaimProvenanceSubstrate('claim-provenance');

beforeAll(async () => {
  await substrate.open();
}, 300_000);

afterAll(async () => {
  await substrate.close();
});

describe('two memories that name one source', () => {
  it('exposes the shared origin rather than serving them as two witnesses', async () => {
    const pack = await substrate.recall('prov-read-shared');
    const episodes = pack.episodes ?? [];

    const alpha = episodes.find((entry) => entry.id === substrate.alphaId);
    const beta = episodes.find((entry) => entry.id === substrate.betaId);
    expect(alpha?.derivation?.roots).toEqual([ROOT_ID]);
    expect(beta?.derivation?.roots).toEqual([ROOT_ID]);

    // The root episode is in the pack too, and it is the source both of them name, so each of
    // the two points back at whichever item claimed the root first rather than at each other.
    expect(alpha?.derivation?.shared_with).toEqual([ROOT_ID]);
    expect(beta?.derivation?.shared_with).toEqual([ROOT_ID]);
    expect(pack.rendered_text).toContain('not independent corroboration');
  });

  it('marks the lineage short when a stated source resolved to nothing', async () => {
    const pack = await substrate.recall('prov-read-incomplete');
    const correction = (pack.episodes ?? []).find((entry) => entry.id === substrate.correctionId);

    expect(correction?.derivation?.complete).toBe(false);
    expect(pack.rendered_text).toContain('lineage incomplete');
  });
});

describe('what the substrate can say about who stands behind a line', () => {
  it('prints the recorded role and still calls the authorship unknown', async () => {
    const pack = await substrate.recall('prov-read-authorship');
    const turn = (pack.episodes ?? []).find((entry) => entry.id === TURN_ID);

    expect(turn?.standing?.kind).toBe('recorded_utterance');
    expect(turn?.standing?.recorded_role).toBe('user');
    expect(turn?.standing?.attribution).toBe('reported');
    expect(turn?.standing?.confirmed).toBeUndefined();
    expect(pack.rendered_text).toContain('said, role user, authorship unknown');
  });

  it('names the confirmer only where a confirmation record cites its evidence', async () => {
    const pack = await substrate.recall('prov-read-confirmed');
    const alpha = (pack.episodes ?? []).find((entry) => entry.id === substrate.alphaId);

    expect(alpha?.standing?.attribution).toBe('attributed');
    expect(alpha?.standing?.confirmed?.by).toBe(CONFIRMER);
    expect(alpha?.standing?.confirmed?.evidence).toBe(CONFIRMATION_EVIDENCE);
    expect(pack.rendered_text).toContain(
      `confirmed by ${CONFIRMER} at 2026-06-01T09:00:00.000Z, evidence: ${CONFIRMATION_EVIDENCE}`,
    );
  });
});

/**
 * Nothing ever supersedes a turn, so a belief stated in one answers as current whichever pass
 * found it. The annotation has to reach a turn the query matched head on, not only one the
 * second pass surfaced alone, and such a turn carries no supersession edge to key on.
 */
describe('a stale belief the query matched directly', () => {
  it('carries the current claim from its subject family in the episodes bucket', async () => {
    const pack = await substrate.recall('prov-read-family');
    const turn = (pack.episodes ?? []).find((entry) => entry.id === TURN_ID);

    expect(turn?.related_claim?.id).toBe(FAMILY_CLAIM_ID);
    expect((pack.facts ?? []).map((entry) => entry.id)).not.toContain(FAMILY_CLAIM_ID);
    expect(turn?.currency).toBe('current');
    expect(turn?.superseded_by).toBeUndefined();
    expect(pack.rendered_text).toContain(`current related claim: ${FAMILY_CLAIM_TEXT}`);
  });
});

describe('a raw turn somebody stated a correction against', () => {
  it('routes the correction to lineage and closes nothing', async () => {
    const pack = await substrate.recall('prov-read-correction');
    const turn = (pack.episodes ?? []).find((entry) => entry.id === TURN_ID);

    expect(turn?.claimed_correction?.by).toBe(substrate.correctionId);
    expect(pack.rendered_text).toContain('nothing has closed it');

    // The node itself is untouched: a reference the caller supplied is evidence for the judge,
    // never a close on its own.
    const stored = await fetchNodeProvenance(substrate.driver, TURN_ID, withCurrency(RECALLED_AT));
    expect(stored?.currency).toBe('current');
    expect(stored?.supersededBy).toBeUndefined();
    expect(turn?.currency).toBe('current');
  });
});

describe('superseded material', () => {
  it('serves the successor first and marks history the pack is not holding', async () => {
    const pack = await substrate.recall('prov-read-superseded');
    const facts = pack.facts ?? [];
    const oldIndex = facts.findIndex((entry) => entry.id === OLD_CLAIM_ID);
    const newIndex = facts.findIndex((entry) => entry.id === NEW_CLAIM_ID);

    expect(oldIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeGreaterThanOrEqual(0);
    expect(newIndex).toBeLessThan(oldIndex);
    expect(facts[oldIndex]?.currency).toBe('superseded');
    expect(facts[oldIndex]?.successor_absent).toBeUndefined();
  });

  it('stays reachable at its own vantage point, unmarked and in its own place', async () => {
    const pack = await substrate.recall('prov-read-historical', {
      knew_at: BEFORE_SUPERSESSION.toISOString(),
    });
    const old = (pack.facts ?? []).find((entry) => entry.id === OLD_CLAIM_ID);

    expect(old?.currency).toBe('current');
    expect(old?.successor_absent).toBeUndefined();
    expect(pack.rendered_text).not.toContain('successor not served');

    // Same read against the graph directly, so the pack's answer is the substrate's answer.
    const stored = await fetchNodeProvenance(
      substrate.driver,
      OLD_CLAIM_ID,
      knewAt(BEFORE_SUPERSESSION),
    );
    expect(stored?.currency).toBe('current');
  });
});

describe('a memory whose standing moved after the session read it', () => {
  const SESSION = 'prov-read-restanding';

  it('re-serves the line once somebody confirms it', async () => {
    const first = await substrate.recall(SESSION);
    expect((first.episodes ?? []).map((entry) => entry.id)).toContain(substrate.betaId);

    // Nothing changed in between, so the session already holds it.
    const second = await substrate.recall(SESSION);
    expect((second.episodes ?? []).map((entry) => entry.id)).not.toContain(substrate.betaId);

    await substrate.push(
      'a later note confirming the sampling interval',
      'prov-session-confirm-beta',
      {
        confirmations: [{ target: substrate.betaId, by: CONFIRMER, evidence: 'standup notes' }],
      },
    );

    const third = await substrate.recall(SESSION);
    const beta = (third.episodes ?? []).find((entry) => entry.id === substrate.betaId);
    expect(beta?.standing?.confirmed?.evidence).toBe('standup notes');
  });
});
