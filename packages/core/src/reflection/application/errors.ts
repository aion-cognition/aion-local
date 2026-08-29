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
