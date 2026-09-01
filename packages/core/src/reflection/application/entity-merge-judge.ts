import { z } from 'zod';

import { errorMessage } from '../../infrastructure/errors.js';
import type { ChatMessage, JsonSchema, Provider } from '../../infrastructure/providers/types.js';
import type { EntityMergeJudgePass } from '../../infrastructure/sqlite/entity-merge-decisions.js';
import { ENTITY_TYPES } from '../domain/entity-extraction.js';
import type { TypeCounts } from '../domain/entity-reconciliation.js';

/**
 * The two model calls tier 3 of the entity cascade makes on a nominated pair, the same two-pass
 * shape `claim-dedup-judge.ts` and `supersession-review.ts` use: one call proposes, a second
 * argues the other side on the same evidence, and only unanimous agreement merges.
 *
 * The question here is about the world rather than about strings. Identity keys on `name_norm`
 * alone, so a pair reaching this judge has two genuinely different names and every deterministic
 * reading of them has already declined. What the judge weighs is the tier-2 evidence: how much
 * history the two share, how much of their neighbourhood, how their names relate, and what each
 * side is described as. Type is in the prompt as evidence and is never a filter, because the
 * duplicates the re-key exists to collapse are exactly the ones one extractor called a tool and
 * the next called a topic.
 *
 * No confidence is asked for, parsed, or recorded. A model's self-reported certainty is not a
 * quantity anything here may threshold on.
 */

export type EntityMergeSide = {
  readonly name: string;
  readonly aliases: readonly string[];
  /** The label the node currently wears, which the counted readings below may disagree with. */
  readonly type: string;
  readonly typeCounts: TypeCounts;
  /** The stored description. Absent on an entity written before any description was generated. */
  readonly description?: string;
};

export type EntityMergePair = {
  readonly subject: EntityMergeSide;
  readonly candidate: EntityMergeSide;
  /** The tier-2 facts, one sentence each, already measured and already in prose. */
  readonly facts: readonly string[];
};

export type EntityMergeCallOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** The run's own abort. A shutdown must not wait out a model call with a minute left. */
  readonly signal?: AbortSignal;
};

const NO_REASON_GIVEN = 'the reviewer gave no reason';

const NOTHING_RECORDED = 'none recorded';

const NO_EVIDENCE = 'no evidence measured for this pair';

const DETECT_SYSTEM_PROMPT = [
  'You judge whether two named entities in a memory substrate are one thing in the world under',
  'two names, or two different things.',
  'Answer same only when one referent explains both records: the same person, the same tool, the',
  'same project, the same place. A nickname, an abbreviation, a fuller form of the same name, and',
  'a product named after the company that makes it are all one referent.',
  'Answer not the same when the two are related but distinct: two versions, two instances, two',
  'credentials, two services in one system, a person and the team named after them, or a tool and',
  'the topic it belongs to. Say not the same rather than guess.',
  'The two records may carry different type labels. A label is a counted reading of what the',
  'extractor thought, not a fact about the world, so two different labels are no reason on their',
  'own to answer either way.',
  'Answer with same and a one-clause rationale naming the referent, or naming what separates the',
  'two.',
].join(' ');

const REVIEW_SYSTEM_PROMPT = [
  'You review a claim that two named entities in a memory substrate are one thing under two',
  'names, and your job is to argue the other side.',
  'Look for one thing in the world that the two records cannot both describe: a version, an',
  'instance, an environment, a component of the other, a namesake, or an identifier that belongs',
  'to exactly one of them. Two records can share most of a name, most of their history, and most',
  'of their neighbourhood and still be two things.',
  'Answer different_referent true the moment you find such a separation, naming it in one',
  'sentence. Answer false only when nothing in the evidence separates them and merging the two',
  'would lose nothing a reader of either record could have relied on.',
  'Differing type labels are not a separation: the labels are counted extractor readings, not',
  'facts about the world.',
].join(' ');

/** Taxonomy order, so two sides' counted readings are listed the same way whatever wrote them. */
function describeTypeCounts(counts: TypeCounts): string {
  const stated = ENTITY_TYPES.flatMap((type) => {
    const count = counts[type];
    return count === undefined ? [] : [`${type} ${String(count)}`];
  });
  return stated.length === 0 ? NOTHING_RECORDED : stated.join(', ');
}

function describeSide(label: string, side: EntityMergeSide): string {
  const aliases = side.aliases.length === 0 ? NOTHING_RECORDED : side.aliases.join(', ');
  const description = side.description?.trim();
  return [
    `${label}: ${side.name}`,
    `  also answers to: ${aliases}`,
    `  current label: ${side.type}`,
    `  readings observed: ${describeTypeCounts(side.typeCounts)}`,
    `  described as: ${
      description === undefined || description.length === 0 ? NOTHING_RECORDED : description
    }`,
  ].join('\n');
}

/**
 * The one user message both passes see. Exported for the same reason the calls are: a battery
 * that rebuilt the prompt would report a number for a judge the service does not run.
 */
export function describeEntityMergePair(pair: EntityMergePair): string {
  const facts = pair.facts.length === 0 ? [NO_EVIDENCE] : pair.facts;
  return [
    describeSide('Entity A', pair.subject),
    '',
    describeSide('Entity B', pair.candidate),
    '',
    'What the graph records about the two together:',
    ...facts.map((fact) => `  - ${fact}`),
  ].join('\n');
}

function buildMessages(systemPrompt: string, pair: EntityMergePair): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: describeEntityMergePair(pair) },
  ];
}

const DETECT_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    same: { type: 'boolean' },
    rationale: { type: 'string' },
  },
  required: ['same'],
};

/**
 * `reason` is declared first for the reason `supersession-review.ts` declares it first: the
 * model fills the fields in order, and a reviewer that has to name the separation before it
 * answers gives a different answer from one that answers first.
 */
const REVIEW_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    different_referent: { type: 'boolean' },
  },
  required: ['reason', 'different_referent'],
};

/** Looser than the JSON schema on purpose: a verdict missing its prose is still a verdict. */
const DetectSchema = z.object({
  same: z.boolean(),
  rationale: z.string().optional(),
});

const ReviewSchema = z.object({
  different_referent: z.boolean(),
  reason: z.string().optional(),
});

/** `failed` covers a call that threw, timed out, or answered in a shape the schema refuses. */
export type EntityMergeJudgeOutcome =
  | { readonly status: 'judged'; readonly judgment: EntityMergeJudgePass }
  | { readonly status: 'failed'; readonly detail: string };

export type EntityMergeReviewOutcome =
  | { readonly status: 'reviewed'; readonly review: EntityMergeJudgePass }
  | { readonly status: 'failed'; readonly detail: string };

type Deadline = { readonly signal: AbortSignal; readonly clear: () => void };

/**
 * The call's own timeout, aborted early when the run is shutting down. Both are one signal, so
 * a stopped stage never waits out a model call with time left on it.
 */
function deadlineFor(options: EntityMergeCallOptions): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);
  const caller = options.signal;
  const onAbort = (): void => {
    controller.abort();
  };
  if (caller !== undefined) {
    if (caller.aborted) {
      controller.abort();
    } else {
      caller.addEventListener('abort', onAbort, { once: true });
    }
  }
  return {
    signal: controller.signal,
    clear: (): void => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

async function ask(
  provider: Pick<Provider, 'generate'>,
  messages: ChatMessage[],
  schema: JsonSchema,
  options: EntityMergeCallOptions,
): Promise<{ readonly raw: unknown } | { readonly detail: string }> {
  const deadline = deadlineFor(options);
  if (deadline.signal.aborted) {
    deadline.clear();
    return { detail: 'the run stopped before the call started' };
  }
  try {
    const raw = await provider.generate({
      model: options.model,
      messages,
      schema,
      // A pair comparison is not helped by reasoning, and the stage pays for it twice over:
      // this call and the second pass both fire on every pair that reaches tier 3.
      think: false,
      signal: deadline.signal,
    });
    return { raw };
  } catch (error) {
    return { detail: errorMessage(error) };
  } finally {
    deadline.clear();
  }
}

function statedRationale(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? fallback : trimmed;
}

/** Pass one: does one referent explain both records? */
export async function judgeEntityMerge(
  provider: Pick<Provider, 'generate'>,
  pair: EntityMergePair,
  options: EntityMergeCallOptions,
): Promise<EntityMergeJudgeOutcome> {
  const answer = await ask(
    provider,
    buildMessages(DETECT_SYSTEM_PROMPT, pair),
    DETECT_JSON_SCHEMA,
    options,
  );
  if ('detail' in answer) {
    return { status: 'failed', detail: answer.detail };
  }

  const parsed = DetectSchema.safeParse(answer.raw);
  if (!parsed.success) {
    return { status: 'failed', detail: 'the judge answered in a shape the schema refuses' };
  }
  return {
    status: 'judged',
    judgment: {
      same: parsed.data.same,
      rationale: statedRationale(parsed.data.rationale, 'the judge gave no reason'),
    },
  };
}

/**
 * Pass two, arguing the other side of an affirmative pass-one answer. It sees the same evidence
 * and nothing else: the first pass's verdict and rationale are withheld, since a reviewer shown
 * the answer it is reviewing agrees with it.
 */
export async function reviewEntityMerge(
  provider: Pick<Provider, 'generate'>,
  pair: EntityMergePair,
  options: EntityMergeCallOptions,
): Promise<EntityMergeReviewOutcome> {
  const answer = await ask(
    provider,
    buildMessages(REVIEW_SYSTEM_PROMPT, pair),
    REVIEW_JSON_SCHEMA,
    options,
  );
  if ('detail' in answer) {
    return { status: 'failed', detail: answer.detail };
  }

  const parsed = ReviewSchema.safeParse(answer.raw);
  if (!parsed.success) {
    return { status: 'failed', detail: 'the reviewer answered in a shape the schema refuses' };
  }
  return {
    status: 'reviewed',
    review: {
      same: !parsed.data.different_referent,
      rationale: statedRationale(parsed.data.reason, NO_REASON_GIVEN),
    },
  };
}
