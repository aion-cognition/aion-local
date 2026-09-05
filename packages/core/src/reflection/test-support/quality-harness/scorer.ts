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
  /** The same overlap over claim text, which is the only identity a cognitive node carries. */
  readonly cognitiveTextOverlap: number | undefined;
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

/** Jaccard similarity of trimmed, lowercased strings. Two empty sets agree completely. */
export function overlap(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a.map((value) => value.trim().toLowerCase()));
  const setB = new Set(b.map((value) => value.trim().toLowerCase()));
  if (setA.size === 0 && setB.size === 0) {
    return 1;
  }
  const intersectionSize = [...setA].filter((value) => setB.has(value)).length;
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
    return { entityNameOverlap: undefined, cognitiveTextOverlap: undefined };
  }
  const [first, second] = outcomes as [(typeof outcomes)[0], (typeof outcomes)[0]];
  if (!first.entities.ok || !second.entities.ok || !first.cognitive.ok || !second.cognitive.ok) {
    return { entityNameOverlap: undefined, cognitiveTextOverlap: undefined };
  }
  return {
    entityNameOverlap: overlap(
      first.entities.value.entities.map((entity) => entity.name),
      second.entities.value.entities.map((entity) => entity.name),
    ),
    cognitiveTextOverlap: overlap(
      first.cognitive.value.nodes.map((node) => node.text),
      second.cognitive.value.nodes.map((node) => node.text),
    ),
  };
}
