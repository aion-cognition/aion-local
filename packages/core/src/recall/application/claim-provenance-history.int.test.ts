import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BEFORE_SUPERSESSION,
  ClaimProvenanceSubstrate,
  CONFIRMER,
  CUE_VECTOR,
  OFF_TOPIC,
  RECALLED_AT,
  ROOT_ID,
  SEEDED_AT,
  SUPERSEDED_AT,
  VECTORS,
} from './test-support/claim-provenance.fixture.js';
import { fetchClaimProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { knewAt, withCurrency } from '../../infrastructure/graph/read-modes.js';

/**
 * What a lineage read answers at a vantage the caller pinned, and what it refuses to answer
 * there: a source chain the substrate held, and the corrections and confirmations it had not
 * acquired yet.
 */

const substrate = new ClaimProvenanceSubstrate('claim-provenance-history');

beforeAll(async () => {
  await substrate.open();
}, 300_000);

afterAll(async () => {
  await substrate.close();
});

describe('lineage the substrate did not hold at the pinned moment', () => {
  it('preserves the root through two source episodes and extraction', async () => {
    const echo = await substrate.push('echo through alpha', 'review-chain', {
      derived_from: [substrate.alphaId],
    });
    await substrate.writeClaim(
      'review-extracted',
      'claim from echoed alpha',
      VECTORS.alpha ?? CUE_VECTOR,
    );
    await upsertEdge(substrate.driver, {
      type: 'EXTRACTED_FROM',
      sourceId: 'review-extracted',
      targetId: echo,
      strength: 1,
      confidence: 1,
      signals: ['provenance'],
      provenance: ['test'],
      count: 0,
      now: SEEDED_AT,
    });
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: ['review-extracted', substrate.betaId],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    expect(rows.get(substrate.betaId)?.roots).toEqual([ROOT_ID]);
    expect(rows.get('review-extracted')).toMatchObject({ roots: [ROOT_ID], complete: true });
  });

  it('does not report a correction learned after knew_at', async () => {
    await substrate.writeEpisode('review-history-target', 'history target', OFF_TOPIC);
    await substrate.push(
      'later correction evidence',
      'review-history-correction',
      {
        supersedes: ['review-history-target'],
      },
      SUPERSEDED_AT,
    );
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: ['review-history-target'],
      maxRoots: 3,
      mode: knewAt(BEFORE_SUPERSESSION),
    });
    expect(rows.get('review-history-target')?.claimedCorrection).toBeUndefined();
  });

  it('does not report a confirmation learned after knew_at', async () => {
    await substrate.writeEpisode(
      'review-confirm-history-target',
      'confirmation history target',
      OFF_TOPIC,
    );
    await substrate.push(
      'later confirmation evidence',
      'review-history-confirmation',
      {
        confirmations: [
          { target: 'review-confirm-history-target', by: CONFIRMER, evidence: 'later review' },
        ],
      },
      SUPERSEDED_AT,
    );
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: ['review-confirm-history-target'],
      maxRoots: 3,
      mode: knewAt(BEFORE_SUPERSESSION),
    });
    expect(rows.get('review-confirm-history-target')?.confirmation).toBeUndefined();
  });

  it('preserves confirmation time on an identical intake retry', async () => {
    await substrate.writeEpisode('review-retry-target', 'confirmation retry target', OFF_TOPIC);
    const provenance = {
      confirmations: [{ target: 'review-retry-target', by: CONFIRMER, evidence: 'same review' }],
    };
    const first = await substrate.push('same confirmation', 'review-retry', provenance, SEEDED_AT);
    const second = await substrate.push(
      'same confirmation',
      'review-retry',
      provenance,
      SUPERSEDED_AT,
    );
    expect(second).toBe(first);
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: ['review-retry-target'],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    // The retry was accepted four days later and states the same confirmation. The first record
    // stands, so the moment on the edge is the first acceptance's and not the retry's.
    expect(rows.get('review-retry-target')?.confirmation?.at).toEqual(SEEDED_AT);
  });

  it('redacts a known synthetic credential inside confirmation evidence', async () => {
    await substrate.writeEpisode('review-redact-target', 'redaction target', OFF_TOPIC);
    const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await substrate.push('confirmation containing a credential', 'review-redact', {
      confirmations: [
        { target: 'review-redact-target', by: CONFIRMER, evidence: `review contains ${secret}` },
      ],
    });
    const rows = await fetchClaimProvenance(substrate.driver, {
      ids: ['review-redact-target'],
      maxRoots: 3,
      mode: withCurrency(RECALLED_AT),
    });
    expect(rows.get('review-redact-target')?.confirmation?.evidence).not.toContain(secret);
  });
});
