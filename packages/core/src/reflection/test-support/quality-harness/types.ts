import type { CognitiveNodeLabel } from '../../../infrastructure/graph/cognitive-queries.js';
import type { EntityType } from '../../domain/entity-extraction.js';

/**
 * The taxonomies come from the stages themselves, so a type added to either one reaches the
 * harness without a second edit and the two cannot disagree about what a valid answer is.
 */
export type ExtractedEntity = {
  readonly name: string;
  readonly type: EntityType;
};

export type EntityExtractionResult = {
  readonly entities: readonly ExtractedEntity[];
};

/** A claim's identity is its text: the graph folds and keys nodes on it, and gives them no name. */
export type ExtractedCognitiveNode = {
  readonly type: CognitiveNodeLabel;
  readonly text: string;
};

export type CognitiveExtractionResult = {
  readonly nodes: readonly ExtractedCognitiveNode[];
};

export type ExtractionRoute = 'local' | 'anthropic';

export type ExtractorOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number };

/**
 * The injectable seam: given raw episode text, produce one extraction result. The
 * harness's default implementation (`provider-extractor.ts`) calls a `Provider` with the
 * prompts and schemas the stages ship; a later caller can point this at the stages
 * themselves instead. Scoring and reporting stay unchanged.
 */
export type EntityExtractorFn = (text: string) => Promise<ExtractorOutcome<EntityExtractionResult>>;
export type CognitiveExtractorFn = (
  text: string,
) => Promise<ExtractorOutcome<CognitiveExtractionResult>>;
