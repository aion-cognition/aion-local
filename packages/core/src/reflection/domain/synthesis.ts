import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The pure half of reflective synthesis: what a neighbourhood reduces to before a model reads
 * it, what a usable answer is, and the key the pass is reconsidered under. No graph, no SQLite,
 * no model call.
 *
 * A synthesis is a conclusion drawn ACROSS memories rather than extracted from one, so two
 * things stay separable at every step: the premises it rests on, and the fact that it is an
 * inference. A reader who cannot tell a drawn conclusion from a quoted one cannot correct
 * either, which is why the premise ids travel from selection through to publication and the
 * inference flag is written rather than assumed.
 */

/** One memory the pass selected as available evidence. */
export type SynthesisPremise = {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  /** The lifecycle revision the premise stood at when this pass selected it. */
  readonly revision: number;
};

/**
 * A conclusion already drawn over part of this neighbourhood.
 *
 * It reaches the model as an interpretation with its own roots, never as another independent
 * witness: two readings of one set of memories are one piece of evidence read twice, and a pass
 * that counted them separately would find agreement it manufactured.
 */
export type PriorConclusion = {
  readonly id: string;
  readonly text: string;
  readonly revision: number;
  readonly premiseIds: readonly string[];
};

/** What the new conclusion does to the standing of the one it names. */
export type SynthesisOutcome =
  | { readonly kind: 'new' }
  /** The same proposition at the same scope, revised. The earlier version is closed and kept. */
  | { readonly kind: 'replaces'; readonly priorId: string }
  /** A second reading the evidence also supports. Both stay current and are linked. */
  | { readonly kind: 'alternative'; readonly priorId: string };

export const SYNTHESIS_INFERENCES = ['new', 'replaces', 'alternative'] as const;

export type SynthesisInference = (typeof SYNTHESIS_INFERENCES)[number];

const ConclusionSchema = z.object({
  text: z.string().min(1),
  premises: z.array(z.string().min(1)).min(1),
  inference: z.enum(SYNTHESIS_INFERENCES),
  revises: z.string().min(1).optional(),
  confidence: z.number().optional(),
  rationale: z.string().optional(),
});

export type ReadConclusion = z.infer<typeof ConclusionSchema>;

const AnswerSchema = z.object({ conclusions: z.array(z.unknown()) });

export type SynthesisAnswer =
  | {
      readonly status: 'read';
      readonly conclusions: readonly ReadConclusion[];
      readonly dropped: number;
    }
  | { readonly status: 'unusable' };

/**
 * The answer, validated one conclusion at a time.
 *
 * A model that malforms one entry otherwise costs the pass every conclusion it got right, which
 * is the same reading cognitive extraction settled on. A reply that is not a list of
 * conclusions at all is still an unusable answer.
 */
export function parseSynthesisAnswer(raw: unknown): SynthesisAnswer {
  const outer = AnswerSchema.safeParse(raw);
  if (!outer.success) {
    return { status: 'unusable' };
  }
  const conclusions: ReadConclusion[] = [];
  let dropped = 0;
  for (const entry of outer.data.conclusions) {
    const parsed = ConclusionSchema.safeParse(entry);
    if (parsed.success) {
      conclusions.push(parsed.data);
      continue;
    }
    dropped += 1;
  }
  return { status: 'read', conclusions, dropped };
}

/** The tag a premise is shown under, so the model can cite it without seeing an id. */
export function premiseTag(index: number): string {
  return `M${String(index + 1)}`;
}

/** The tag a prior conclusion is shown under. Separate letter, so the two sets cannot collide. */
export function priorTag(index: number): string {
  return `C${String(index + 1)}`;
}

function tagged<T>(entries: readonly T[], tag: (index: number) => string): ReadonlyMap<string, T> {
  return new Map(entries.map((entry, index) => [tag(index), entry]));
}

/**
 * What this pass concluded about one neighbourhood, ready to write.
 *
 * The premise ids are the ones the pass selected before generation, resolved from the tags the
 * model cited. Nothing here is read back out of the answer's own prose.
 */
export type PlannedConclusion = {
  readonly text: string;
  readonly premiseIds: readonly string[];
  readonly outcome: SynthesisOutcome;
  readonly confidence: number;
  readonly rationale: string;
};

export type SynthesisPlan = {
  readonly conclusions: readonly PlannedConclusion[];
  /** Why each refused conclusion was refused, one line each, for the stage's own summary. */
  readonly refused: readonly string[];
  /** Conclusions past the cap, which the pass declines rather than truncating silently. */
  readonly overflow: number;
};

/** A confidence the model did not state, or stated outside [0,1], reads as an even split. */
const DEFAULT_CONFIDENCE = 0.5;

function confidenceOf(entry: ReadConclusion): number {
  const stated = entry.confidence;
  if (stated === undefined || !Number.isFinite(stated)) {
    return DEFAULT_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, stated));
}

type Refusal = { readonly refused: string };

function resolveOutcome(
  entry: ReadConclusion,
  priors: ReadonlyMap<string, PriorConclusion>,
): SynthesisOutcome | Refusal {
  if (entry.inference === 'new') {
    return { kind: 'new' };
  }
  if (entry.revises === undefined) {
    return { refused: `${entry.inference} names no prior conclusion this pass showed` };
  }
  const prior = priors.get(entry.revises);
  if (prior === undefined) {
    return { refused: `${entry.inference} names ${entry.revises}, which this pass did not show` };
  }
  return { kind: entry.inference, priorId: prior.id };
}

/**
 * The conclusions this pass will write, and why it declined the rest.
 *
 * Two refusals, each of them a shape that would otherwise write a node nobody can trace. A
 * conclusion citing no premise the pass selected rests on evidence nothing here read, and a
 * revision naming a conclusion the pass never showed is a claim about a node the model
 * invented. Both are questions about whether the evidence exists.
 *
 * Whether a conclusion over evidence the pass did show is worth drawing is not one of them. The
 * nomination is what bounds the reading; inside that bound the conclusion is the model's, and a
 * grounded reading of memories it was shown is refused on no other ground than these two.
 */
export function plannedConclusions(
  conclusions: readonly ReadConclusion[],
  input: {
    readonly premises: readonly SynthesisPremise[];
    readonly priors: readonly PriorConclusion[];
    readonly max: number;
  },
): SynthesisPlan {
  const premises = tagged(input.premises, premiseTag);
  const priors = tagged(input.priors, priorTag);
  const planned: PlannedConclusion[] = [];
  const refused: string[] = [];
  let overflow = 0;

  for (const entry of conclusions) {
    const cited = [
      ...new Set(entry.premises.map((tag) => premises.get(tag)).filter((row) => row !== undefined)),
    ];
    if (cited.length === 0) {
      refused.push(`${entry.inference} cites no premise this pass showed`);
      continue;
    }
    const outcome = resolveOutcome(entry, priors);
    if ('refused' in outcome) {
      refused.push(outcome.refused);
      continue;
    }
    if (planned.length >= input.max) {
      overflow += 1;
      continue;
    }
    planned.push({
      text: entry.text.trim(),
      premiseIds: cited.map((premise) => premise.id),
      outcome,
      confidence: confidenceOf(entry),
      rationale: entry.rationale?.trim() ?? '',
    });
  }

  return { conclusions: planned, refused, overflow };
}

/**
 * The key one neighbourhood's synthesis pass is recorded under.
 *
 * It is folded from what the pass actually read: every premise and every prior conclusion, each
 * at the revision it stood at when the pass selected it. Two properties follow, and both are
 * the point. A pass that concluded nothing marks this key and is not asked again about the same
 * reading, which is what keeps an unproductive neighbourhood from costing a call per episode.
 * And the moment any of that evidence is revised, or a memory joins the neighbourhood, the key
 * is a different one, so the no-change answer does not silence a neighbourhood whose evidence
 * has since moved.
 *
 * The parts join on a NUL escape, which no id can contain, so two different readings cannot
 * fold to one key. Written as `\u0000` rather than as the byte: a literal NUL makes git read
 * the file as binary and drop diff, blame and text search for it.
 */
export function synthesisNeighbourhoodKey(
  pipelineVersion: string,
  premises: readonly SynthesisPremise[],
  priors: readonly PriorConclusion[],
): string {
  const parts = [
    ...premises.map((premise) => `m:${premise.id}:${String(premise.revision)}`),
    ...priors.map((prior) => `c:${prior.id}:${String(prior.revision)}`),
  ].sort();
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `reflection.synthesis:${pipelineVersion}:${digest}`;
}
