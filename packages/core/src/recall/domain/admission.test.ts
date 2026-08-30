import { describe, expect, it } from 'vitest';

import {
  admissionEvidence,
  admitsOnEvidence,
  wasMeasured,
  type AdmissionPolicy,
  type Measurement,
} from './admission.js';

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

  it('admits any hit again under the pre-floor mode, the behaviour the floors replaced', () => {
    expect(admits([plain], { ...CALIBRATED, bm25Mode: 'any' })).toBe(true);
  });

  it('admits an exact entity-name resolution without measuring a cosine', () => {
    expect(
      admits([{ method: 'entity_resolution', relevance: 1, exact: true, cue: 'Ryan Huber' }]),
    ).toBe(true);
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
  it('admits nothing, which is what refuses a node nothing could measure', () => {
    expect(admits([])).toBe(false);
  });
});

/**
 * A node the spread reached is measured against the query cues and enters the gate carrying
 * that cosine, so the rule it faces is the seed rule. These are the same two floors read from
 * the arrival side.
 */
describe('a node the spread reached', () => {
  it('is admitted by its own measured cosine at the floor', () => {
    expect(admits([{ method: 'vector', relevance: 0.63, cue: 'outbox table' }])).toBe(true);
  });

  it('is refused when the measurement lands under the floor', () => {
    expect(admits([{ method: 'vector', relevance: 0.31, cue: 'outbox table' }])).toBe(false);
  });

  it('is refused on the reach itself, however strongly the graph connects it', () => {
    expect(admits([{ method: 'activation', relevance: 0.98 }])).toBe(false);
  });
});

/**
 * What the gate reports back about an admission. The score is the one a pack prints, so it has
 * to be a number the admitting rule read: a leg that measured 0.44 and admitted nothing is not
 * what let the item in, and printing its number beside the item reads as a floor that leaked.
 */
describe('what the gate says admitted an item', () => {
  it('names the vector floor and the cosine that cleared it', () => {
    expect(
      admissionEvidence([{ method: 'vector', relevance: 0.72, cue: 'outbox table' }], CALIBRATED),
    ).toEqual({ rule: 'vector_floor', score: 0.72, qualifying: ['vector 0.72'] });
  });

  it('names the literal match and reports no measurement behind it', () => {
    expect(
      admissionEvidence(
        [
          { method: 'bm25', relevance: 1, exact: true, cue: 'SQLITE_BUSY' },
          { method: 'vector', relevance: 0.44, cue: 'SQLITE_BUSY' },
        ],
        CALIBRATED,
      ),
    ).toEqual({ rule: 'exact_match', score: 0, qualifying: ['bm25 exact'] });
  });

  it('names both legs that corroborated and the stronger cosine of the two', () => {
    expect(
      admissionEvidence(
        [
          { method: 'vector', relevance: 0.47, cue: 'remittance ingest' },
          { method: 'vector', relevance: 0.46, cue: 'outbox table' },
        ],
        CALIBRATED,
      ),
    ).toEqual({
      rule: 'corroborated',
      score: 0.47,
      qualifying: ['vector 0.47', 'vector 0.46'],
    });
  });

  it('counts a verbatim lexical hit as one leg of a corroboration in the strict mode', () => {
    expect(
      admissionEvidence(
        [
          { method: 'bm25', relevance: 1, exact: true, cue: 'spoke tension' },
          { method: 'vector', relevance: 0.46, cue: 'spoke tension' },
        ],
        { ...CALIBRATED, bm25Mode: 'corroborated' },
      ),
    ).toEqual({
      rule: 'corroborated',
      score: 0.46,
      qualifying: ['bm25 exact', 'vector 0.46'],
    });
  });

  it('names the escape hatch when an uncalibrated lexical hit admits alone', () => {
    expect(
      admissionEvidence([{ method: 'bm25', relevance: 1, cue: 'bicycle wheel spoke' }], {
        ...CALIBRATED,
        bm25Mode: 'any',
      }),
    ).toEqual({ rule: 'bm25_any', score: 0, qualifying: ['bm25 1.00'] });
  });

  it('says nothing admitted the item when no rule fired', () => {
    expect(
      admissionEvidence([{ method: 'vector', relevance: 0.31, cue: 'outbox table' }], CALIBRATED),
    ).toBeUndefined();
  });
});

describe('telling a refusal apart from a candidate nothing judged', () => {
  it('reads a cosine as a measurement, whatever it came out at', () => {
    expect(wasMeasured([{ method: 'vector', relevance: 0.02, cue: 'monsoon rainfall' }])).toBe(
      true,
    );
  });

  it('reads a literal match as a measurement, since the gate judged it', () => {
    expect(wasMeasured([{ method: 'bm25', relevance: 1, exact: true, cue: 'SQLITE_BUSY' }])).toBe(
      true,
    );
  });

  it('says nothing judged an arrival whose content vector is still pending', () => {
    expect(wasMeasured([])).toBe(false);
  });

  it('says nothing judged a hit from a leg that measures something other than relevance', () => {
    expect(wasMeasured([{ method: 'recency', relevance: 0 }])).toBe(false);
    expect(wasMeasured([{ method: 'activation', relevance: 0.7 }])).toBe(false);
    expect(wasMeasured([{ method: 'bm25', relevance: 1, cue: 'outbox' }])).toBe(false);
  });
});
