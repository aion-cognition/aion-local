import type {
  CognitiveExtractionResult,
  EntityExtractionResult,
  ExtractionRoute,
  ExtractorOutcome,
} from './types.js';

export type CallMetrics = {
  readonly ok: boolean;
  readonly count: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly latencyMs: number;
  readonly error?: string;
};

export type FixtureRouteMetrics = {
  readonly route: ExtractionRoute;
  readonly model: string;
  readonly entities: CallMetrics;
  readonly cognitive: CallMetrics;
};

export type FixtureAgreement = {
  /** Jaccard overlap of normalized entity names between exactly two ok routes; undefined otherwise. */
  readonly entityNameOverlap: number | undefined;
  readonly cognitiveNameOverlap: number | undefined;
};

function countByType(items: readonly { readonly type: string }[]): Record<string, number> {
  const byType: Record<string, number> = {};
  for (const item of items) {
    byType[item.type] = (byType[item.type] ?? 0) + 1;
  }
  return byType;
}

export function summarizeEntities(outcome: ExtractorOutcome<EntityExtractionResult>): CallMetrics {
  if (!outcome.ok) {
    return { ok: false, count: 0, byType: {}, latencyMs: outcome.latencyMs, error: outcome.error };
  }
  return {
    ok: true,
    count: outcome.value.entities.length,
    byType: countByType(outcome.value.entities),
    latencyMs: outcome.latencyMs,
  };
}

export function summarizeCognitive(
  outcome: ExtractorOutcome<CognitiveExtractionResult>,
): CallMetrics {
  if (!outcome.ok) {
    return { ok: false, count: 0, byType: {}, latencyMs: outcome.latencyMs, error: outcome.error };
  }
  return {
    ok: true,
    count: outcome.value.nodes.length,
    byType: countByType(outcome.value.nodes),
    latencyMs: outcome.latencyMs,
  };
}

/** Jaccard similarity of trimmed, lowercased names. Two empty sets agree completely. */
export function nameOverlap(
  a: readonly { readonly name: string }[],
  b: readonly { readonly name: string }[],
): number {
  const setA = new Set(a.map((item) => item.name.trim().toLowerCase()));
  const setB = new Set(b.map((item) => item.name.trim().toLowerCase()));
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  const intersectionSize = [...setA].filter((name) => setB.has(name)).length;
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 1 : intersectionSize / unionSize;
}

/**
 * Agreement is defined only when exactly two routes both ran successfully. The harness
 * compares local against Anthropic, not N-way. Any other count leaves it unset rather than
 * picking an arbitrary pair.
 */
export function computeAgreement(
  outcomes: readonly {
    readonly entities: ExtractorOutcome<EntityExtractionResult>;
    readonly cognitive: ExtractorOutcome<CognitiveExtractionResult>;
  }[],
): FixtureAgreement {
  if (outcomes.length !== 2) {
    return { entityNameOverlap: undefined, cognitiveNameOverlap: undefined };
  }
  const [first, second] = outcomes as [(typeof outcomes)[0], (typeof outcomes)[0]];
  if (!first.entities.ok || !second.entities.ok || !first.cognitive.ok || !second.cognitive.ok) {
    return { entityNameOverlap: undefined, cognitiveNameOverlap: undefined };
  }
  return {
    entityNameOverlap: nameOverlap(first.entities.value.entities, second.entities.value.entities),
    cognitiveNameOverlap: nameOverlap(first.cognitive.value.nodes, second.cognitive.value.nodes),
  };
}
