import { describe, expect, it } from 'vitest';
import { admitsOnEvidence, type AdmissionPolicy, type Measurement } from './admission.js';

/** The shipped shape: a calibrated cosine floor, a lower corroboration floor, exact-only BM25. */
const CALIBRATED: AdmissionPolicy = {
  vectorFloor: 0.5,
  corroborationFloor: 0.45,
  bm25Mode: 'exact',
};

function admits(
  measurements: readonly Measurement[],
  policy: AdmissionPolicy = CALIBRATED,
): boolean {
  return admitsOnEvidence(measurements, policy);
}

describe('a cosine on its own', () => {
  it('admits at the floor and refuses under it', () => {
    expect(admits([{ method: 'vector', relevance: 0.5, cue: 'outbox table' }])).toBe(true);
    expect(admits([{ method: 'vector', relevance: 0.49, cue: 'outbox table' }])).toBe(false);
  });

  it('reads entity similarity on the same cosine scale', () => {
    expect(admits([{ method: 'entity_resolution', relevance: 0.72, cue: 'Postgres' }])).toBe(true);
    expect(admits([{ method: 'entity_resolution', relevance: 0.44, cue: 'Postgres' }])).toBe(false);
  });

  it('never admits on recency, which measures nothing about the query', () => {
    expect(admits([{ method: 'recency', relevance: 1 }])).toBe(false);
  });
});

describe('lexical evidence', () => {
  const plain: Measurement = { method: 'bm25', relevance: 1, cue: 'bicycle wheel spoke' };
  const verbatim: Measurement = { ...plain, exact: true };

  it('refuses a plain hit, whatever its normalized score says', () => {
    expect(admits([plain])).toBe(false);
  });

  it('admits a hit Lucene matched on the verbatim cue', () => {
    expect(admits([verbatim])).toBe(true);
  });

  it('holds even a verbatim hit back in the strict mode', () => {
    expect(admits([verbatim], { ...CALIBRATED, bm25Mode: 'corroborated' })).toBe(false);
    expect(
      admits([verbatim, { method: 'vector', relevance: 0.46, cue: 'spoke tension' }], {
        ...CALIBRATED,
        bm25Mode: 'corroborated',
      }),
    ).toBe(true);
  });

  it('admits any hit again under the pre-floor mode, which is what EX-1 measured', () => {
    expect(admits([plain], { ...CALIBRATED, bm25Mode: 'any' })).toBe(true);
  });

  it('admits an exact entity-name resolution without measuring a cosine', () => {
    expect(admits([{ method: 'entity_resolution', relevance: 1, exact: true, cue: 'Ryan Huber' }])).toBe(
      true,
    );
  });
});

describe('corroboration', () => {
  it('admits a node two cues found sub-floor, which neither could carry alone', () => {
    expect(
      admits([
        { method: 'vector', relevance: 0.47, cue: 'remittance ingest' },
        { method: 'vector', relevance: 0.46, cue: 'outbox table' },
      ]),
    ).toBe(true);
  });

  it('counts two methods on one cue as two measurements', () => {
    expect(
      admits([
        { method: 'vector', relevance: 0.47, cue: 'remittance ingest' },
        { method: 'entity_resolution', relevance: 0.46, cue: 'remittance ingest' },
      ]),
    ).toBe(true);
  });

  it('does not count the same method and cue twice, however many legs carried it', () => {
    expect(
      admits([
        { method: 'vector', relevance: 0.47, cue: 'remittance ingest' },
        { method: 'vector', relevance: 0.47, cue: 'remittance ingest' },
      ]),
    ).toBe(false);
  });

  it('ignores a measurement under the corroboration floor', () => {
    expect(
      admits([
        { method: 'vector', relevance: 0.47, cue: 'remittance ingest' },
        { method: 'vector', relevance: 0.44, cue: 'outbox table' },
      ]),
    ).toBe(false);
  });

  /**
   * The exercise's quantum query: cue "surface codes" shares a term with an ops-surface
   * concept and measures 0.475 against it, which is inside the noise band. Letting a plain
   * lexical hit corroborate a sub-floor cosine would re-admit exactly that item.
   */
  it('never lets a plain BM25 hit be one of the two', () => {
    expect(
      admits([
        { method: 'vector', relevance: 0.475, cue: 'surface codes' },
        { method: 'bm25', relevance: 1, cue: 'surface codes' },
      ]),
    ).toBe(false);
  });
});

describe('no evidence at all', () => {
  it('admits nothing, which is what leaves a traversal-only candidate to the anchor rule', () => {
    expect(admits([])).toBe(false);
  });
});
