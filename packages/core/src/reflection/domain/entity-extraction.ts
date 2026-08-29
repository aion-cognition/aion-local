import { z } from 'zod';
import type { JsonSchema } from '../../infrastructure/providers/types.js';
import { foldName } from '../../infrastructure/providers/unicode-fold.js';

/**
 * Whitepaper §6.4: the model names entities and their types, and this module is everything
 * that happens to that answer before it reaches the graph — nothing here reads the episode
 * text. Names are folded to a canonical key and the list is deduplicated on `(name_norm,
 * type)`, which is the pair the graph's uniqueness constraint is declared on: two rows the
 * model returned separately would otherwise race each other into the same MERGE.
 */

/**
 * §6.4's taxonomy, fixed because `type` is half of the identity key. A type the model
 * invents forks an identity the graph has no way to merge back together, so structured
 * output constrains the field and anything off-taxonomy still lands on a known type
 * rather than dropping an entity the episode really named.
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

const FALLBACK_ENTITY_TYPE: EntityType = 'concept';

/** A name longer than this is a sentence the model mislabelled, not an identity worth a node. */
const MAX_ENTITY_NAME_LENGTH = 120;

/** The context is embedded and stored, not read back as prose, so it is capped rather than summarized. */
const MAX_ENTITY_CONTEXT_LENGTH = 400;

export type ExtractedEntity = {
  readonly name: string;
  /** The canonical key: `name` trimmed, inner whitespace collapsed, lowercased. */
  readonly nameNorm: string;
  readonly type: EntityType;
  /** One clause about the entity as this episode used it. Empty when the model gave none. */
  readonly context: string;
};

/**
 * `graph/backbone.ts`, `graph/seed-queries.ts` and the embedding path all fold through the
 * same `foldName`; `entity-extraction.test.ts` asserts they agree. Key folding on a name, not
 * term derivation: nothing is split, stemmed, or dropped.
 */
export function normalizeEntityName(name: string): string {
  return foldName(name);
}

export function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

/** Passed to the provider verbatim as the structured-output format. */
export const ENTITY_EXTRACTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: [...ENTITY_TYPES] },
          context: { type: 'string' },
        },
        required: ['name', 'type', 'context'],
      },
    },
  },
  required: ['entities'],
};

/**
 * Looser than the JSON schema on purpose. The schema is what the model is steered by; this
 * is what a returned payload has to satisfy to be usable, and rejecting a whole extraction
 * because one entity omitted its context would spend the retry on nothing.
 */
const EntityExtractionOutputSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
      context: z.string().optional(),
    }),
  ),
});

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * A separator no normalized name can hold: `normalizeEntityName` collapses whitespace, so a
 * space cannot appear twice in a row and the two halves stay unambiguous. It used to be a
 * literal NUL byte, which works at runtime and makes git treat this whole file as binary,
 * so every diff of it renders as "Binary files differ" instead of the source.
 */
const IDENTITY_SEPARATOR = '  ';

function identityKey(nameNorm: string, type: EntityType): string {
  return `${nameNorm}${IDENTITY_SEPARATOR}${type}`;
}

/**
 * Undefined means the payload was not an extraction at all and the caller should retry with
 * it in the prompt. An empty array means the model read the episode and named nothing in it,
 * which is a real answer about an episode that mentions no entity.
 */
export function parseExtractedEntities(
  raw: unknown,
  maxEntities: number,
): readonly ExtractedEntity[] | undefined {
  const parsed = EntityExtractionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }

  const byIdentity = new Map<string, ExtractedEntity>();
  for (const candidate of parsed.data.entities) {
    if (byIdentity.size >= maxEntities) {
      break;
    }

    const name = collapse(candidate.name);
    if (name.length === 0 || name.length > MAX_ENTITY_NAME_LENGTH) {
      continue;
    }

    const declared = candidate.type ?? '';
    const type = isEntityType(declared) ? declared : FALLBACK_ENTITY_TYPE;
    const nameNorm = normalizeEntityName(name);
    const key = identityKey(nameNorm, type);
    if (byIdentity.has(key)) {
      continue;
    }

    byIdentity.set(key, {
      name,
      nameNorm,
      type,
      context: collapse(candidate.context ?? '').slice(0, MAX_ENTITY_CONTEXT_LENGTH),
    });
  }

  return [...byIdentity.values()];
}

/**
 * What gets stored as the entity's `text` and embedded into its content vector. The
 * worker's pending-vector drain embeds `text` verbatim, so the stored string and the
 * embedded string have to be the same one or a drained entity would carry a vector for
 * text it does not hold.
 */
export function entityContentText(entity: ExtractedEntity): string {
  const head = `${entity.name} (${entity.type})`;
  if (entity.context.length === 0) {
    return head;
  }
  return `${head}: ${entity.context}`;
}
