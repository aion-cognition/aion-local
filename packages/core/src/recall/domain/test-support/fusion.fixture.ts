import type { RecallMethod } from '@aion/protocol';

import type { AdmissionPolicy, Measurement, TypedInboundEvidence } from '../admission.js';
import {
  fuse,
  type FusedItem,
  type FusionCandidate,
  type FusionOptions,
  type RankedList,
} from '../fusion.js';

/**
 * The candidate and list builders both fusion test files run on. They were two copies that
 * differed by one override field, so a change to the candidate shape had to be made twice and
 * the two drifted between edits.
 */

export const RRF_CONSTANT = 60;

/**
 * The ranking cases are about order, not admission, so they run under a policy that admits
 * everything. Every floor assertion names its own policy.
 */
export const ADMIT_ALL: AdmissionPolicy = {
  vectorFloor: 0,
  corroborationFloor: 0,
  bm25Mode: 'any',
};

/** The shipped shape: a calibrated cosine floor, a lower corroboration floor, exact-only BM25. */
export const CALIBRATED: AdmissionPolicy = {
  vectorFloor: 0.6,
  corroborationFloor: 0.55,
  bm25Mode: 'exact',
};

export const RRF: FusionOptions = {
  rrfConstant: RRF_CONSTANT,
  admission: ADMIT_ALL,
  reranker: 'rrf',
  mmrLambda: 0.5,
  clusterCap: 2,
  clusterCosineThreshold: 0.95,
};

export type CandidateOverrides = {
  readonly content?: string;
  readonly method?: RecallMethod;
  readonly relevance?: number;
  readonly superseded?: boolean;
  readonly activation?: number;
  readonly structural?: boolean;
  readonly labels?: readonly string[];
  readonly evidence?: readonly Measurement[];
  readonly typedEvidence?: TypedInboundEvidence;
  readonly mentionCount?: number;
};

export function candidate(id: string, overrides: CandidateOverrides = {}): FusionCandidate {
  const method = overrides.method ?? 'vector';
  const relevance = overrides.relevance ?? 0.8;
  const base = {
    id,
    labels: overrides.labels ?? ['Episode', 'Memory'],
    content: overrides.content ?? `content of ${id}`,
    rationale: { method, score: overrides.activation ?? relevance },
    relevance,
    ...(overrides.evidence === undefined ? {} : { evidence: overrides.evidence }),
    ...(overrides.activation === undefined ? {} : { activation: overrides.activation }),
    ...(overrides.structural === undefined ? {} : { isStructural: overrides.structural }),
    ...(overrides.typedEvidence === undefined ? {} : { typedEvidence: overrides.typedEvidence }),
    ...(overrides.mentionCount === undefined ? {} : { mentionCount: overrides.mentionCount }),
  };
  if (overrides.superseded !== true) {
    return { ...base, currency: 'current' as const };
  }
  return {
    ...base,
    currency: 'superseded' as const,
    supersededBy: { id: `${id}-successor`, at: new Date('2026-08-01T00:00:00.000Z') },
  };
}

export function list(
  leg: RankedList['leg'],
  candidates: readonly FusionCandidate[],
  weight = 1,
): RankedList {
  return { leg, weight, candidates };
}

export function items(
  lists: readonly RankedList[],
  options: FusionOptions = RRF,
): readonly FusedItem[] {
  return fuse(lists, options).items;
}

export function ids(fused: readonly { readonly id: string }[]): string[] {
  return fused.map((item) => item.id);
}
