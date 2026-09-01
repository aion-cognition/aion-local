import { z } from 'zod';

import type { JsonSchema } from '../../infrastructure/providers/types.js';
import { foldName } from '../../infrastructure/providers/unicode-fold.js';

/**
 * The model names entities and their types, and this module is everything that happens to
 * that answer before it reaches the graph. Nothing here reads the episode text. Names are
 * folded to a canonical key and the list is deduplicated on `name_norm` alone, which is what
 * the graph's uniqueness constraint is declared on since migration 003: two rows the model
 * returned separately would otherwise race each other into the same MERGE.
 *
 * One name typed two ways is one identity here, not two. The model is unstable in the type it
 * picks, and keying on the pair made that instability mint a second node the dedup cascade
 * then had to rediscover. Both typings survive as observations for reconciliation to weigh.
 */

/**
 * A fixed taxonomy, because `type` is counted evidence rather than free text. A type the model
 * invents would carry its own count and could win the reconciliation, so structured output
 * constrains the field and anything off-taxonomy still lands on a known type rather than
 * dropping an entity the episode really named.
 *
 * `topic` and not `concept`: the entity type would otherwise share a name with the `Concept`
 * fact label, and every prompt and human reading the schema has to tell the two apart. `event`
 * keeps its name, where the notions genuinely coincide.
 */
export const ENTITY_TYPES = [
  'person',
  'organization',
  'project',
  'tool',
  'topic',
  'location',
  'event',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const FALLBACK_ENTITY_TYPE: EntityType = 'topic';

/** A name longer than this is a sentence the model mislabelled, not an identity worth a node. */
const MAX_ENTITY_NAME_LENGTH = 120;

/** The context is embedded and stored, not read back as prose, so it is capped rather than summarized. */
const MAX_ENTITY_CONTEXT_LENGTH = 400;

/**
 * An entity worth naming answers to a handful of names. Past that the model has started
 * listing every phrase the episode used, and each one is a lookup key that routes some other
 * identity's mentions onto this node.
 */
const MAX_ENTITY_ALIASES = 8;

/** Two contexts for one name are two readings of it, kept in the order the model gave them. */
const CONTEXT_JOINER = '; ';

export type ExtractedEntity = {
  readonly name: string;
  /** The canonical key: `name` trimmed, inner whitespace collapsed, lowercased. */
  readonly nameNorm: string;
  /** The label proposal: the first type this payload gave the name, and always `types[0]`. */
  readonly type: EntityType;
  /** Every distinct type this payload gave the name, first seen first. Reconciliation counts these. */
  readonly types: readonly EntityType[];
  /** One clause about the entity as this episode used it. Empty when the model gave none. */
  readonly context: string;
  /** Other names the record used for it, folded the way `nameNorm` is, own name excluded. */
  readonly aliases: readonly string[];
  /** The record's user said this one is them. A verdict, so there is no number to threshold on. */
  readonly isSpeaker: boolean;
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
          aliases: { type: 'array', items: { type: 'string' } },
          is_speaker: { type: 'boolean' },
        },
        // The two new fields stay out of `required`: most entities have neither, and forcing
        // the model to emit an empty list and a false for every one of them buys nothing.
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
      // Unknown rather than typed: a model that answers `aliases` with a bare string or
      // `is_speaker` with "yes" is wrong about one field, and rejecting the payload over it
      // would spend the one retry re-reading an episode the model already read correctly.
      aliases: z.unknown().optional(),
      is_speaker: z.unknown().optional(),
    }),
  ),
});

function collapse(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Aliases are lookup keys, so they fold exactly as `nameNorm` does or an absorbed name never
 * matches the query that should find it. An alias that folds onto its own entity is not a
 * second name for it, and a duplicate is one key twice.
 */
function foldAliases(raw: unknown, nameNorm: string): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const folded: string[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const alias = normalizeEntityName(candidate);
    if (alias.length === 0 || alias.length > MAX_ENTITY_NAME_LENGTH) {
      continue;
    }
    if (alias === nameNorm || folded.includes(alias)) {
      continue;
    }

    folded.push(alias);
  }

  return folded.slice(0, MAX_ENTITY_ALIASES);
}

/** A reading the joined string already carries is not a second reading, so it is not appended. */
function joinContexts(existing: string, addition: string): string {
  if (addition.length === 0 || existing.includes(addition)) {
    return existing;
  }
  if (existing.length === 0) {
    return addition;
  }
  return `${existing}${CONTEXT_JOINER}${addition}`.slice(0, MAX_ENTITY_CONTEXT_LENGTH);
}

/**
 * One name the model returned more than once, folded onto the identity already accepted. The
 * surface name and the label proposal are the first reading's; everything the later readings
 * add is evidence, so it accumulates rather than replacing.
 */
function absorb(existing: ExtractedEntity, addition: ExtractedEntity): ExtractedEntity {
  const types = existing.types.includes(addition.type)
    ? existing.types
    : [...existing.types, addition.type];
  const aliases = [...existing.aliases];
  for (const alias of addition.aliases) {
    if (!aliases.includes(alias)) {
      aliases.push(alias);
    }
  }

  return {
    ...existing,
    types,
    context: joinContexts(existing.context, addition.context),
    aliases: aliases.slice(0, MAX_ENTITY_ALIASES),
    isSpeaker: existing.isSpeaker || addition.isSpeaker,
  };
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
    const name = collapse(candidate.name);
    if (name.length === 0 || name.length > MAX_ENTITY_NAME_LENGTH) {
      continue;
    }

    const nameNorm = normalizeEntityName(name);
    const existing = byIdentity.get(nameNorm);
    // The cap counts identities, not rows: a repeat of a name already accepted costs no node,
    // and dropping it would lose the aliases and typings that reading contributed.
    if (existing === undefined && byIdentity.size >= maxEntities) {
      break;
    }

    const declared = candidate.type ?? '';
    const type = isEntityType(declared) ? declared : FALLBACK_ENTITY_TYPE;
    const extracted: ExtractedEntity = {
      name,
      nameNorm,
      type,
      types: [type],
      context: collapse(candidate.context ?? '').slice(0, MAX_ENTITY_CONTEXT_LENGTH),
      aliases: foldAliases(candidate.aliases, nameNorm),
      isSpeaker: candidate.is_speaker === true,
    };

    byIdentity.set(nameNorm, existing === undefined ? extracted : absorb(existing, extracted));
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
