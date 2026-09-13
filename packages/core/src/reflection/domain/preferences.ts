import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The pure half of preference inference: what a pass reads, what a usable answer is, and the key
 * the pass is recorded under. No graph, no SQLite, no model call.
 *
 * A preference is read off how somebody worked, never off a sentence they are supposed to have
 * said. Two rules follow and both are enforced here rather than in the prompt. The recorded role
 * of every signal travels with the preference, because a transport role is a label the calling
 * client chose and agent-to-agent traffic arrives under `user` like anything else. And a signal
 * that is the substrate repeating a preference back cannot ground one, because a pass that
 * counted it would read its own output as fresh human evidence.
 */

/** One interaction the pass may read a preference off. */
export type PreferenceSignal = {
  readonly id: string;
  /** The role capture recorded, verbatim. It says something was said, never who said it. */
  readonly role: string;
  readonly text: string;
  /** True where the substrate itself produced this line, so it stands for nothing new. */
  readonly echo: boolean;
};

/** A preference already held, shown to the model so a later signal can revise it. */
export type StandingPreference = {
  readonly id: string;
  readonly text: string;
  readonly revision: number;
  readonly scope: PreferenceScope;
  /**
   * The condition a contextual one holds under, absent on an unconditional one. Shown with the
   * text: a model asked whether today's line revises a held preference cannot answer about "does
   * not require approval" without knowing that it was held for throwaway test stores only.
   */
  readonly context?: string;
  readonly groundIds: readonly string[];
};

export const PREFERENCE_SCOPES = ['standing', 'contextual'] as const;

export type PreferenceScope = (typeof PREFERENCE_SCOPES)[number];

/** What a new preference does to the standing of the one it names. */
export type PreferenceOutcome =
  { readonly kind: 'new' } | { readonly kind: 'replaces'; readonly priorId: string };

const PreferenceSchema = z.object({
  text: z.string().min(1),
  grounds: z.array(z.string().min(1)).min(1),
  scope: z.enum(PREFERENCE_SCOPES),
  /** Required of a contextual preference: the situation it holds in, in the model's own words. */
  context: z.string().min(1).optional(),
  revises: z.string().min(1).optional(),
  confidence: z.number().optional(),
});

export type ReadPreference = z.infer<typeof PreferenceSchema>;

const AnswerSchema = z.object({ preferences: z.array(z.unknown()) });

export type PreferenceAnswer =
  | {
      readonly status: 'read';
      readonly preferences: readonly ReadPreference[];
      readonly dropped: number;
    }
  | { readonly status: 'unusable' };

/** Validated one preference at a time, for the reason every other extraction answer is. */
export function parsePreferenceAnswer(raw: unknown): PreferenceAnswer {
  const outer = AnswerSchema.safeParse(raw);
  if (!outer.success) {
    return { status: 'unusable' };
  }
  const preferences: ReadPreference[] = [];
  let dropped = 0;
  for (const entry of outer.data.preferences) {
    const parsed = PreferenceSchema.safeParse(entry);
    if (parsed.success) {
      preferences.push(parsed.data);
      continue;
    }
    dropped += 1;
  }
  return { status: 'read', preferences, dropped };
}

/** The tag a signal is shown under. */
export function signalTag(index: number): string {
  return `S${String(index + 1)}`;
}

/** The tag a standing preference is shown under. Separate letter, so the sets cannot collide. */
export function standingTag(index: number): string {
  return `P${String(index + 1)}`;
}

function tagged<T>(entries: readonly T[], tag: (index: number) => string): ReadonlyMap<string, T> {
  return new Map(entries.map((entry, index) => [tag(index), entry]));
}

export type PlannedPreference = {
  readonly text: string;
  readonly groundIds: readonly string[];
  /** The recorded roles behind it, deduplicated, in the order the signals were shown. */
  readonly roles: readonly string[];
  readonly scope: PreferenceScope;
  readonly context?: string;
  readonly outcome: PreferenceOutcome;
  readonly confidence: number;
};

export type PreferencePlan = {
  readonly preferences: readonly PlannedPreference[];
  readonly refused: readonly string[];
  readonly overflow: number;
};

const DEFAULT_CONFIDENCE = 0.5;

function confidenceOf(entry: ReadPreference): number {
  const stated = entry.confidence;
  if (stated === undefined || !Number.isFinite(stated)) {
    return DEFAULT_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, stated));
}

type Refusal = { readonly refused: string };

function resolveOutcome(
  entry: ReadPreference,
  standing: ReadonlyMap<string, StandingPreference>,
): PreferenceOutcome | Refusal {
  if (entry.revises === undefined) {
    return { kind: 'new' };
  }
  const prior = standing.get(entry.revises);
  if (prior === undefined) {
    return { refused: `a revision of ${entry.revises}, which this pass did not show` };
  }
  return { kind: 'replaces', priorId: prior.id };
}

/**
 * The preferences this pass will write, and why it declined the rest.
 *
 * Four refusals. A preference citing no signal the pass showed rests on nothing here. A
 * contextual preference with no context named is a standing preference with a hedge on it, and
 * storing one would serve a narrow habit as a general rule. A revision naming a preference the
 * pass never showed is about a node the model invented. And a preference grounded only in lines
 * the substrate itself produced is the substrate confirming itself: an agent repeating an
 * inferred preference back is not a second, human observation of it.
 */
export function plannedPreferences(
  preferences: readonly ReadPreference[],
  input: {
    readonly signals: readonly PreferenceSignal[];
    readonly standing: readonly StandingPreference[];
    readonly max: number;
  },
): PreferencePlan {
  const signals = tagged(input.signals, signalTag);
  const standing = tagged(input.standing, standingTag);
  const planned: PlannedPreference[] = [];
  const refused: string[] = [];
  let overflow = 0;

  for (const entry of preferences) {
    const cited = [
      ...new Set(entry.grounds.map((tag) => signals.get(tag)).filter((row) => row !== undefined)),
    ];
    if (cited.length === 0) {
      refused.push('a preference grounded in no signal this pass showed');
      continue;
    }
    if (cited.every((signal) => signal.echo)) {
      refused.push('a preference grounded only in the substrate repeating itself');
      continue;
    }
    if (entry.scope === 'contextual' && entry.context === undefined) {
      refused.push('a contextual preference that names no context');
      continue;
    }
    const outcome = resolveOutcome(entry, standing);
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
      groundIds: cited.map((signal) => signal.id),
      roles: [...new Set(cited.map((signal) => signal.role))],
      scope: entry.scope,
      ...(entry.context === undefined ? {} : { context: entry.context.trim() }),
      outcome,
      confidence: confidenceOf(entry),
    });
  }

  return { preferences: planned, refused, overflow };
}

/**
 * The key one episode's preference pass is recorded under.
 *
 * It carries the episode, every signal the pass read, and every standing preference it was
 * shown at the revision it stood at. A pass that read the same interaction under the same
 * standing preferences is not asked twice; a pass whose standing preferences have since moved
 * is, because the question it answers has changed.
 *
 * The parts join on a NUL escape, which no id can contain. Written as `\u0000` rather than as
 * the byte: a literal NUL makes git read the file as binary.
 */
export function preferenceSignalKey(
  pipelineVersion: string,
  episodeId: string,
  signals: readonly PreferenceSignal[],
  standing: readonly StandingPreference[],
): string {
  const parts = [
    ...signals.map((signal) => `s:${signal.id}`),
    ...standing.map((prior) => `p:${prior.id}:${String(prior.revision)}`),
  ].sort();
  const digest = createHash('sha256')
    .update([episodeId, ...parts].join('\u0000'))
    .digest('hex');
  return `reflection.preferences:${pipelineVersion}:${digest}`;
}
