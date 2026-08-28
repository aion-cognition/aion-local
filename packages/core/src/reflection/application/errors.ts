/**
 * Intake could not complete, and nothing durable came of the call: no episode, and so no
 * queue row either, because the row is keyed on an episode id that was never minted.
 *
 * PRD §10 says reflection jobs queue until the service returns. They do not yet — intake
 * embeds before it opens the write transaction, so an inference or graph outage leaves the
 * experience dropped rather than pending. Until the durable record is written first, the
 * caller is told exactly that, because an agent that believes its reflection was queued
 * will not push it again.
 */
const CAUSE_TEXT = {
  embed: 'the embedding call failed',
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
