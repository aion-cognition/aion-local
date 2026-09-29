import type { CognitiveNodeLabel } from '../../../infrastructure/graph/cognitive-queries.js';
import type { GenerationProvider } from '../../../infrastructure/providers/types.js';
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

export type ExtractionRoute = GenerationProvider;

/**
 * Why a call produced no usable answer, decided at the call boundary off the error's own type.
 *
 * `refused` is the one that is not an answer at all: the spending guard turned this request back
 * before it was sent, so this request was not dispatched and not billed. Counting it beside a
 * malformed model answer says a case failed that was never asked. The distinction is carried as a
 * field rather than recovered by reading `error`, because a caller matching on the wording of an
 * error sentence is one message edit away from misclassifying a refusal.
 *
 * This is a fact about one request, not necessarily about the whole logical case a caller builds
 * from it: a structured call that retries once can dispatch and get billed on its first request,
 * then see `refused` from the second. A caller composing more than one request into a case checks
 * what was actually recorded before treating a `refused` verdict as "nothing happened here".
 */
export type ExtractionFailure = 'refused' | 'timeout' | 'call_failed' | 'invalid_output';

export type ExtractorOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly latencyMs: number }
  | {
      readonly ok: false;
      readonly error: string;
      readonly latencyMs: number;
      readonly failure: ExtractionFailure;
    };

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
