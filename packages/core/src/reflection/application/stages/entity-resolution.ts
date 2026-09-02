import {
  addEntityAliases,
  findEntityNameForms,
  findSpeakerEntity,
  mergeEntities,
  writeEntityVectors,
  type EntityIdentityMatch,
  type EntityMergeInput,
  type EntityNameForms,
  type EntityVectorEntry,
  type MergedEntity,
} from '../../../infrastructure/graph/entity-queries.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import {
  entityContentText,
  normalizeEntityName,
  type ExtractedEntity,
} from '../../domain/entity-extraction.js';
import type { StageContext } from '../../domain/stage.js';
import { entityNameVectorText, vectorInputHash } from '../../domain/vector-input.js';

/**
 * Which node an extracted name lands on, and which of that node's two vectors this run has to
 * compute. Four tiers, tried in order and each one deterministic: the speaker is the backbone,
 * a name the backbone answers to is the backbone, an absorbed alias is the identity already
 * holding it, and anything left mints its own.
 *
 * Nothing here decides a duplicate. Every tier is exact string evidence over folded forms, and
 * only over names a record actually used for the identity; a name two identities answer to
 * falls through to the cascade rather than being resolved on a tie-break. Evidence about the
 * shape of a name (squash equality, bigram overlap) belongs to the cascade too, whose merge is
 * reversible where a write-time route is not.
 */

/** Provenance: which pipeline path put the node in the graph. */
export const ENTITY_EXTRACTION_METHOD = 'reflection_entities';

/**
 * Structured output constrains the shape, never the reading. The confidence rides on both
 * the node and its MENTIONS edge so a later stage weighing an extracted claim against a
 * stated one can tell them apart.
 */
export const EXTRACTION_CONFIDENCE = 0.8;

/** One vector this run has to compute, with the hash that records what it was taken over. */
type VectorInput = {
  readonly text: string;
  readonly hash: string;
};

/** One resolved identity: the extraction that named it and the node it landed on. */
export type ResolvedEntity = {
  readonly extracted: ExtractedEntity;
  readonly id: string;
  readonly created: boolean;
  readonly structural: boolean;
  /** Absent when the stored name vector was taken over exactly this text already. */
  readonly name?: VectorInput;
  readonly content?: VectorInput;
};

function mergeInput(
  entity: ExtractedEntity,
  ctx: StageContext,
  holder?: EntityIdentityMatch,
): EntityMergeInput {
  // Routing rewrites the identity key, not the reading: the holder's name is what the MERGE
  // seeks, and the spelling this record used joins the holder's aliases so the next record
  // spelling it that way lands here without a second lookup. The surface form alone, since
  // `aliases` is identity history a person reads and `aliasKeys` derives the lookup half.
  const aliases = holder === undefined ? entity.aliases : [...entity.aliases, entity.name];
  return {
    name: holder?.name ?? entity.name,
    nameNorm: holder?.nameNorm ?? entity.nameNorm,
    type: entity.type,
    types: entity.types,
    aliases,
    text: entityContentText(entity),
    sourceEpisodeId: ctx.episodeId,
    extractionMethod: ENTITY_EXTRACTION_METHOD,
    confidence: EXTRACTION_CONFIDENCE,
    occurredAt: ctx.occurredAt,
  };
}

/** One graph read's answer about every extracted name, plus who the record's "I" is. */
type IdentityLookup = EntityNameForms & {
  readonly speaker?: EntityIdentityMatch;
};

/**
 * The identities that already answer to a name this extraction did not spell exactly: the
 * ones holding it as an absorbed alias. A name the graph already keys returns nothing, because
 * the MERGE seeks it on its own, resolves any merge chain forward, and reopens the node if a
 * maintenance close was betting against exactly this mention.
 *
 * An alias is a name a record itself gave the identity, which is why routing on one at write
 * is safe. Separator-squashed equality is not: `re-mark` and `remark` reach one lookup key and
 * are two words, so that evidence goes to the dedup cascade, whose merge carries a provenance
 * record and an undo. A write-time route has neither.
 *
 * Every holder comes back, never a pick. Two identities answering to one form is a duplicate
 * question, and answering it here would route a record's mentions onto whichever row sorted
 * first.
 */
function holdersOf(
  entity: ExtractedEntity,
  lookup: IdentityLookup,
): { readonly tier: string; readonly holders: readonly EntityIdentityMatch[] } | undefined {
  if (lookup.ownedNames.has(entity.nameNorm)) {
    return undefined;
  }

  const byAlias = lookup.forms.filter((form) => form.aliasesNorm.includes(entity.nameNorm));
  if (byAlias.length > 0) {
    return { tier: 'alias', holders: byAlias };
  }
  return undefined;
}

/**
 * Which identity one extraction lands on. The speaker is answered first and by label: a record
 * refers to itself in the first person, and the person saying "I" is the Member every session
 * already hangs off, not a new node the dedup cascade has to rediscover as Ryan later.
 */
function resolveTarget(
  ctx: StageContext,
  entity: ExtractedEntity,
  lookup: IdentityLookup,
): EntityIdentityMatch | undefined {
  if (entity.isSpeaker && lookup.speaker !== undefined) {
    return lookup.speaker;
  }

  const structural = lookup.forms.find(
    (form) => form.isStructural && form.nameNorm === entity.nameNorm,
  );
  if (structural !== undefined) {
    return structural;
  }

  const held = holdersOf(entity, lookup);
  if (held === undefined) {
    return undefined;
  }
  if (held.holders.length > 1) {
    ctx.logger.debug(
      {
        episodeId: ctx.episodeId,
        name: entity.nameNorm,
        tier: held.tier,
        holders: held.holders.map((holder) => holder.id),
      },
      'entity name-form routing skipped: several identities answer to this name',
    );
    return undefined;
  }
  return held.holders[0];
}

/** What the backbone gains from a record that named it: the spellings it was named by. */
function structuralAliases(entity: ExtractedEntity, match: EntityIdentityMatch): string[] {
  return [entity.name, ...entity.aliases].filter(
    (alias) => alias.length > 0 && normalizeEntityName(alias) !== match.nameNorm,
  );
}

/** The name vector's input after this run's aliases land, so its hash is the one the write stores. */
function nameVector(nameNorm: string, aliasesNorm: readonly string[]): VectorInput {
  const text = entityNameVectorText(nameNorm, aliasesNorm);
  return { text, hash: vectorInputHash(text) };
}

function contentVector(entity: ExtractedEntity): VectorInput {
  const text = entityContentText(entity);
  return { text, hash: vectorInputHash(text) };
}

/**
 * The backbone keeps its own type and identity properties (every session already hangs off it)
 * and gains only what any mentioned entity gains: the spelling this record used, a name
 * embedding, the mention edge, and the salience.
 */
async function resolveStructural(
  ctx: StageContext,
  targets: ReadonlyMap<string, { match: EntityIdentityMatch; entities: ExtractedEntity[] }>,
): Promise<ResolvedEntity[]> {
  if (targets.size === 0) {
    return [];
  }

  const added = new Map<string, string[]>();
  for (const [id, target] of targets) {
    added.set(
      id,
      target.entities.flatMap((entity) => structuralAliases(entity, target.match)),
    );
  }
  await addEntityAliases(
    ctx.driver,
    [...added].map(([id, aliases]) => ({
      id,
      nameNorm: targets.get(id)?.match.nameNorm ?? '',
      aliases,
    })),
  );

  const resolved: ResolvedEntity[] = [];
  for (const [id, target] of targets) {
    const aliasesNorm = [
      ...new Set([
        ...target.match.aliasesNorm,
        ...(added.get(id) ?? []).map((alias) => normalizeEntityName(alias)),
      ]),
    ].filter((alias) => alias.length > 0 && alias !== target.match.nameNorm);
    const name = nameVector(target.match.nameNorm, aliasesNorm);

    for (const entity of target.entities) {
      resolved.push({
        extracted: entity,
        id,
        created: false,
        structural: true,
        // The backbone is connectivity, not content: it carries no `text` to embed.
        ...(target.match.nameVectorHash === name.hash ? {} : { name }),
      });
    }
  }
  return resolved;
}

/**
 * Rows pair back to readings by position rather than by name: alias routing rewrites several
 * readings onto one holder's key, and a lookup by that key would answer them all with one row.
 */
function resolveOrganic(
  pairs: readonly { extracted: ExtractedEntity; input: EntityMergeInput }[],
  merged: readonly MergedEntity[],
): ResolvedEntity[] {
  const resolved: ResolvedEntity[] = [];

  for (const row of merged) {
    const pair = pairs[row.reading];
    if (pair === undefined) {
      continue;
    }
    const name = nameVector(row.canonicalNameNorm, row.aliasesNorm);
    resolved.push({
      extracted: pair.extracted,
      id: row.id,
      created: row.created,
      structural: false,
      ...(row.nameVectorHash === name.hash ? {} : { name }),
      // Only a creation's `text` is this run's. A node that matched holds whichever run's text
      // created it, so embedding this extraction's wording would store a vector, and a hash
      // claiming it is current, for a body the node does not carry. The drain reads `text`.
      ...(row.created ? { content: contentVector(pair.extracted) } : {}),
    });
  }
  return resolved;
}

/**
 * One graph read for every resolution tier, then one MERGE for everything that did not route
 * onto an identity the graph already holds.
 */
export async function resolveEntities(
  ctx: StageContext,
  entities: readonly ExtractedEntity[],
): Promise<readonly ResolvedEntity[]> {
  const forms = await findEntityNameForms(
    ctx.driver,
    entities.map((entity) => entity.nameNorm),
  );
  const speaker = entities.some((entity) => entity.isSpeaker)
    ? await findSpeakerEntity(ctx.driver)
    : undefined;
  const lookup: IdentityLookup = { ...forms, ...(speaker === undefined ? {} : { speaker }) };

  const structural = new Map<string, { match: EntityIdentityMatch; entities: ExtractedEntity[] }>();
  const organic: { extracted: ExtractedEntity; input: EntityMergeInput }[] = [];
  for (const entity of entities) {
    const target = resolveTarget(ctx, entity, lookup);
    if (target?.isStructural === true) {
      const held = structural.get(target.id) ?? { match: target, entities: [] };
      held.entities.push(entity);
      structural.set(target.id, held);
      continue;
    }
    organic.push({ extracted: entity, input: mergeInput(entity, ctx, target) });
  }

  const merged = await mergeEntities(
    ctx.driver,
    organic.map((pair) => pair.input),
    ctx.now,
  );

  return [...(await resolveStructural(ctx, structural)), ...resolveOrganic(organic, merged)];
}

/** Where in the one embed batch each of an entity's two vectors landed. */
type VectorSlot = {
  readonly id: string;
  readonly name?: { readonly index: number; readonly hash: string };
  readonly content?: { readonly index: number; readonly hash: string };
};

type VectorPlan = {
  readonly texts: readonly string[];
  readonly slots: readonly VectorSlot[];
};

/**
 * One embed call for the whole extraction, over exactly the vectors whose input has changed.
 * One slot per node, not per reading: several readings of one record can name one identity,
 * and its vectors are a function of the node rather than of how often it was named.
 */
function planVectors(resolved: readonly ResolvedEntity[]): VectorPlan {
  const texts: string[] = [];
  const slots: VectorSlot[] = [];
  const planned = new Set<string>();

  for (const entity of resolved) {
    if (entity.name === undefined && entity.content === undefined) {
      continue;
    }
    if (planned.has(entity.id)) {
      continue;
    }
    planned.add(entity.id);
    slots.push({
      id: entity.id,
      ...(entity.name === undefined
        ? {}
        : { name: { index: texts.push(entity.name.text) - 1, hash: entity.name.hash } }),
      ...(entity.content === undefined
        ? {}
        : { content: { index: texts.push(entity.content.text) - 1, hash: entity.content.hash } }),
    });
  }

  return { texts, slots };
}

/**
 * A provider that returns a short list leaves the tail without vectors rather than
 * mis-pairing it: the node keeps `text` and no `content_vec`, which is the pending-vector
 * marker the worker's drain already resolves.
 */
function pairVectors(plan: VectorPlan, vectors: readonly Vector[]): EntityVectorEntry[] {
  const entries: EntityVectorEntry[] = [];
  for (const slot of plan.slots) {
    const nameVec = slot.name === undefined ? undefined : vectors[slot.name.index];
    const contentVec = slot.content === undefined ? undefined : vectors[slot.content.index];
    if (nameVec === undefined && contentVec === undefined) {
      continue;
    }
    entries.push({
      id: slot.id,
      ...(nameVec === undefined
        ? {}
        : { nameVector: nameVec, nameVectorHash: slot.name?.hash ?? '' }),
      ...(contentVec === undefined
        ? {}
        : { contentVector: contentVec, contentVectorHash: slot.content?.hash ?? '' }),
    });
  }
  return entries;
}

/** True when the vectors are deferred. The entities are already durable, so this never fails the stage. */
export async function attachVectors(
  ctx: StageContext,
  resolved: readonly ResolvedEntity[],
): Promise<boolean> {
  const plan = planVectors(resolved);
  if (plan.texts.length === 0) {
    return false;
  }

  try {
    const vectors = await ctx.provider.embed(plan.texts);
    await writeEntityVectors(ctx.driver, pairVectors(plan, vectors));
    return false;
  } catch (err) {
    // The two vectors recover by different paths. The worker's pending-vector drain writes
    // `content_vec` only, so a missing `name_vec` waits for the next episode that mentions the
    // entity: the stored hash is absent, so that run plans the name embedding again.
    ctx.logger.warn(
      { err, episodeId: ctx.episodeId, entities: resolved.length },
      'entity vectors deferred; the drain embeds the content vector and the next mention the name',
    );
    return true;
  }
}
