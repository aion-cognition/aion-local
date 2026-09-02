import type {
  CognitiveNodeLabel,
  CognitiveNodeWrite,
} from '../../../infrastructure/graph/cognitive-queries.js';
import {
  findEntityNameForms,
  findEpisodeEntities,
  findSpeakerEntity,
} from '../../../infrastructure/graph/entity-queries.js';
import { FACT_NODE_LABELS } from '../../../infrastructure/graph/supersession-queries.js';
import { foldAspect, isTemporalClass, type TemporalClass } from '../../domain/claim-key.js';
import { normalizeEntityName } from '../../domain/entity-extraction.js';
import type { StageContext } from '../../domain/stage.js';

/**
 * What the extractor said about a claim's key, and which entity that subject actually is.
 *
 * Every field arrives as whatever the model returned, so each is narrowed on its own: a class
 * outside the three costs the class, an aspect that folds to nothing costs the key, and neither
 * costs the claim. The claim is the thing the episode paid for; the key is an improvement on it.
 *
 * Resolution is exact-string over stored folds, and an ambiguous answer declines. A subject key
 * has no judge downstream of it, so a name two identities answer to must never be resolved on a
 * tie-break: the wrong subject is a wrong close with nothing to catch it.
 */

/** Keys attach to the fact-bearing types only, which is the same set supersession watches. */
function isFactLabel(label: CognitiveNodeLabel): boolean {
  return (FACT_NODE_LABELS as readonly string[]).includes(label);
}

/** The three key fields as the provider returned them, before anything is believed about them. */
export type ClaimKeyFields = {
  readonly subjectEntity?: unknown;
  readonly aspect?: unknown;
  readonly temporalClass?: unknown;
};

/** The same three after narrowing: the subject still a surface form, the aspect already folded. */
export type ExtractedClaimKey = {
  readonly subject?: string;
  readonly aspectNorm?: string;
  readonly temporalClass?: TemporalClass;
};

export function narrowClaimKey(
  label: CognitiveNodeLabel,
  fields: ClaimKeyFields,
): ExtractedClaimKey {
  if (!isFactLabel(label)) {
    return {};
  }

  const subject = typeof fields.subjectEntity === 'string' ? fields.subjectEntity.trim() : '';
  const aspectNorm = typeof fields.aspect === 'string' ? foldAspect(fields.aspect) : undefined;
  return {
    ...(subject.length === 0 ? {} : { subject }),
    ...(aspectNorm === undefined ? {} : { aspectNorm }),
    ...(isTemporalClass(fields.temporalClass) ? { temporalClass: fields.temporalClass } : {}),
  };
}

/** Folded subject name to the entity id it resolved to. A name that declined is absent. */
export type ClaimSubjects = ReadonlyMap<string, string>;

/**
 * The forms a record uses for itself. Resolved by label rather than by name, because the speaker
 * is the one identity a record refers to without naming, and the backbone Member is who that is.
 */
const FIRST_PERSON_SUBJECTS = new Set(['i', 'me', 'myself']);

/** The key's own half of the write, in the shape the cognitive write takes it. */
export type StoredClaimKey = Pick<
  CognitiveNodeWrite,
  'subjectEntityId' | 'aspectNorm' | 'temporalClass'
>;

/**
 * Which entity each claim subject is, in one read per tier over the whole extraction.
 *
 * Scope is the entities this episode mentions and nothing wider. A global lookup resolves a
 * subject the episode never named, which is the shape most likely to key a claim onto the wrong
 * entity, and the speaker is the one exception: a record names itself in the first person, so
 * there is no surface form in the episode for a mention scope to hold.
 *
 * A subject whose claim brought no aspect is never looked up. Half a key keys nothing, so the
 * read would buy the write nothing either.
 */
export async function resolveClaimSubjects(
  ctx: StageContext,
  keys: readonly ExtractedClaimKey[],
): Promise<ClaimSubjects> {
  const wanted = new Set<string>();
  for (const key of keys) {
    if (key.subject === undefined || key.aspectNorm === undefined) {
      continue;
    }
    const folded = normalizeEntityName(key.subject);
    if (folded.length > 0) {
      wanted.add(folded);
    }
  }
  if (wanted.size === 0) {
    return new Map();
  }

  const resolved = new Map<string, string>();
  const firstPerson = [...wanted].filter((name) => FIRST_PERSON_SUBJECTS.has(name));
  if (firstPerson.length > 0) {
    const speaker = await findSpeakerEntity(ctx.driver);
    if (speaker === undefined) {
      ctx.logger.debug(
        { episodeId: ctx.episodeId, subjects: firstPerson },
        'claim subjects declined: the graph holds no backbone Member for a record to mean by "I"',
      );
    } else {
      for (const name of firstPerson) {
        resolved.set(name, speaker.id);
      }
    }
  }

  const named = [...wanted].filter((name) => !FIRST_PERSON_SUBJECTS.has(name));
  if (named.length === 0) {
    return resolved;
  }

  const mentioned = await findEpisodeEntities(ctx.driver, ctx.episodeId, ctx.now);
  if (mentioned.length === 0) {
    ctx.logger.debug(
      { episodeId: ctx.episodeId, subjects: named },
      'claim subjects declined: the episode mentions no entity to resolve against',
    );
    return resolved;
  }

  // `name_norm` is unique across current entities, so one mentioned name answers to one id and
  // this tier has no ambiguity to decline. The alias tier below is where two holders can appear.
  const byName = new Map(mentioned.map((entity) => [entity.nameNorm, entity.id]));
  const unresolved: string[] = [];
  for (const name of named) {
    const id = byName.get(name);
    if (id === undefined) {
      unresolved.push(name);
      continue;
    }
    resolved.set(name, id);
  }
  if (unresolved.length === 0) {
    return resolved;
  }

  const scope = new Set(mentioned.map((entity) => entity.id));
  const { forms } = await findEntityNameForms(ctx.driver, unresolved);
  for (const name of unresolved) {
    const holders = forms.filter((form) => scope.has(form.id) && form.aliasesNorm.includes(name));
    const holder = holders.length === 1 ? holders[0] : undefined;
    if (holder === undefined) {
      ctx.logger.debug(
        { episodeId: ctx.episodeId, subject: name, holders: holders.map((form) => form.id) },
        'claim subject declined: the episode mentions no single entity answering to this name',
      );
      continue;
    }
    resolved.set(name, holder.id);
  }
  return resolved;
}

/**
 * What one claim stores of its key. Subject and aspect land together or not at all: a claim
 * carrying one half matches nothing and reads as keyed, which is worse than reading as unkeyed.
 * The temporal class is independent of both, because how long a claim answers for is a fact about
 * the claim rather than about the pair it corrects.
 */
export function storedClaimKey(key: ExtractedClaimKey, subjects: ClaimSubjects): StoredClaimKey {
  const temporal = key.temporalClass === undefined ? {} : { temporalClass: key.temporalClass };
  const subjectEntityId =
    key.subject === undefined ? undefined : subjects.get(normalizeEntityName(key.subject));
  if (subjectEntityId === undefined || key.aspectNorm === undefined) {
    return temporal;
  }
  return { subjectEntityId, aspectNorm: key.aspectNorm, ...temporal };
}
