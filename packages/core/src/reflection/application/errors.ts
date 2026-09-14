/**
 * Intake could not complete, and nothing durable came of the call: no episode, and so no
 * queue row either, because the row is keyed on an episode id that was never minted.
 *
 * Only the graph can reach this now. Reflection jobs queue until the service returns, and
 * since intake commits before it embeds, an inference outage costs the vectors and nothing
 * else: the episode is stored, the job is queued, and the call succeeds. An
 * unreachable graph has no such fallback: there is nowhere to put the experience, so the
 * caller is told exactly that, because an agent that believes its reflection was queued
 * will not push it again.
 */
const CAUSE_TEXT = {
  graph: 'the graph is unavailable',
  /** Two live occurrences share this payload, or one is mid-transition. Picking one would
   * record a decision nobody made, so the acceptance refuses instead. */
  occurrence: 'the substrate cannot say which occurrence this is',
  /** The write could not be serialized against the publications already in flight. */
  publication: 'the acceptance could not be published',
} as const;

export type ReflectionFailureStage = keyof typeof CAUSE_TEXT;

export class ReflectionNotStoredError extends Error {
  readonly stage: ReflectionFailureStage;

  constructor(stage: ReflectionFailureStage, cause: unknown) {
    const detail = cause instanceof Error ? ` (${cause.name})` : '';
    super(
      `reflection not stored: ${CAUSE_TEXT[stage]}${detail}. Nothing was written and nothing was queued; send this reflection again once the service is back.`,
      { cause },
    );
    this.name = 'ReflectionNotStoredError';
    this.stage = stage;
  }
}

/**
 * Every turn and tool execution a push carried read, by its own timestamp, before the
 * substrate's own birth. Unlike `ReflectionNotStoredError` this is not a transient failure: a
 * retry of the identical push earns the identical refusal, because the substrate has no
 * business remembering content from before it existed. The birth fence throws this from
 * `handleReflection` itself, which keeps that function's ordinary return shape for every other
 * caller; `handleReflectionResult` is what turns it into the disclosed refusal a client sees.
 */
export class ReflectionPreBirthRefusedError extends Error {
  readonly substrateBornAt: Date;
  readonly refusedTurns: number;
  readonly refusedToolExecutions: number;

  constructor(input: {
    readonly substrateBornAt: Date;
    readonly refusedTurns: number;
    readonly refusedToolExecutions: number;
  }) {
    super(
      `reflection refused: every turn and tool execution in this push reads, by its own ` +
        `timestamp, before the substrate's birth at ${input.substrateBornAt.toISOString()}; ` +
        'nothing was stored.',
    );
    this.name = 'ReflectionPreBirthRefusedError';
    this.substrateBornAt = input.substrateBornAt;
    this.refusedTurns = input.refusedTurns;
    this.refusedToolExecutions = input.refusedToolExecutions;
  }
}
