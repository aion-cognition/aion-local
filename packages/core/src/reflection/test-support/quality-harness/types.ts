/**
 * Whitepaper §6.4's closed set: "person, organization, project, tool, concept, location,
 * event". The harness's own copy of the taxonomy, not a shared source with the real
 * extraction stage (P3-5), which is free to diverge.
 */
export const ENTITY_TYPES = [
  'person',
  'organization',
  'project',
  'tool',
  'concept',
  'location',
  'event',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type ExtractedEntity = {
  readonly name: string;
  readonly type: EntityType;
};

export type EntityExtractionResult = {
  readonly entities: readonly ExtractedEntity[];
};

/** Whitepaper §6.7's nine cognitive node types, lowercased for schema consistency. */
export const COGNITIVE_TYPES = [
  'goal',
  'plan',
  'decision',
  'insight',
  'concept',
  'context',
  'event',
  'pattern',
  'trend',
] as const;

export type CognitiveType = (typeof COGNITIVE_TYPES)[number];

export type ExtractedCognitiveNode = {
  readonly type: CognitiveType;
  readonly name: string;
  readonly description: string;
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
 * harness's default implementation (`provider-extractor.ts`) goes through its own prompts
 * and a `Provider`; a later caller can point this at the real reflection stage's extraction
 * function instead, and everything downstream — scoring, reporting — is unchanged.
 */
export type EntityExtractorFn = (text: string) => Promise<ExtractorOutcome<EntityExtractionResult>>;
export type CognitiveExtractorFn = (text: string) => Promise<ExtractorOutcome<CognitiveExtractionResult>>;
