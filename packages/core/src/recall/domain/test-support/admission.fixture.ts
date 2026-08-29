import type { AdmissionPolicy, AdmissionReport } from '../admission.js';

/**
 * A gate that judged nothing, for a test whose subject is the pack rather than the floors.
 * `assemblePack` requires a report because every real pack has one and a thin pack that
 * cannot say why it is thin is the failure the field exists to close; a fixture that had to
 * restate ten zeroes in every test file would be that requirement's cost paid ten times.
 */
export const NO_CANDIDATES_POLICY: AdmissionPolicy = {
  vectorFloor: 0.6,
  corroborationFloor: 0.45,
  bm25Mode: 'exact',
};

export function admittedAll(count: number): AdmissionReport {
  return {
    policy: NO_CANDIDATES_POLICY,
    considered: count,
    admitted: count,
    droppedBelowFloor: 0,
    droppedUnmeasured: 0,
    droppedDuplicateContent: 0,
    droppedNearDuplicate: 0,
    anchored: count > 0,
  };
}
