import type { ReflectionTurn, ToolExecution } from '@aion/protocol';

import type { ReflectionContent } from './content.js';

/**
 * A substrate must never remember conversation that happened before it did. The axis this
 * fence judges is when a transcript line was itself written: `turn.occurred_at` /
 * `execution.occurred_at`, stamped by the harness from the transcript entry's own timestamp.
 * It is never a date read out of a turn's text. A turn spoken after birth that talks about
 * something from last July is ordinary conversation and passes untouched; the fence tests
 * when a line was spoken, never what it describes.
 *
 * An entry with no timestamp of its own cannot be shown pre-birth from data this function
 * holds, so it passes through unfiltered, exactly as it did before the fence existed. There is
 * no clock-skew tolerance: `birth` and every `occurred_at` this fence compares it against are
 * both read as plain instants, and the boundary is closed at birth itself, so a turn stamped
 * at the exact instant of birth is accepted, not refused.
 */

export type BirthFenceOutcome = {
  readonly content: ReflectionContent;
  /** How many turns this call cut for reading, by their own timestamp, before `birth`. */
  readonly trimmedTurns: number;
  /** The same count for tool executions. */
  readonly trimmedToolExecutions: number;
  /** True when nothing in `content` survived the trim: turns, tool executions, and observations alike. */
  readonly emptied: boolean;
};

function isPreBirth(occurredAt: string | undefined, birth: Date): boolean {
  if (occurredAt === undefined) {
    return false;
  }
  const parsed = new Date(occurredAt);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.getTime() < birth.getTime();
}

function keptTurns(
  turns: readonly ReflectionTurn[] | undefined,
  birth: Date,
): ReflectionTurn[] | undefined {
  return turns === undefined
    ? undefined
    : turns.filter((turn) => !isPreBirth(turn.occurred_at, birth));
}

function keptToolExecutions(
  executions: readonly ToolExecution[] | undefined,
  birth: Date,
): ToolExecution[] | undefined {
  return executions === undefined
    ? undefined
    : executions.filter((execution) => !isPreBirth(execution.occurred_at, birth));
}

/**
 * Refuses or trims the turns and tool executions a reflection push carried, by the axis
 * documented above. `birth` undefined means the substrate's own birth has not been read (no
 * pairing yet, or a guard read that came back empty), which this treats as "nothing to judge
 * against" rather than "born now": every entry passes through unchanged.
 */
export function applyBirthFence(
  content: ReflectionContent,
  birth: Date | undefined,
): BirthFenceOutcome {
  if (birth === undefined) {
    return { content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false };
  }

  const turns = keptTurns(content.turns, birth);
  const toolExecutions = keptToolExecutions(content.tool_executions, birth);
  const trimmedTurns = (content.turns?.length ?? 0) - (turns?.length ?? 0);
  const trimmedToolExecutions =
    (content.tool_executions?.length ?? 0) - (toolExecutions?.length ?? 0);

  if (trimmedTurns === 0 && trimmedToolExecutions === 0) {
    return { content, trimmedTurns: 0, trimmedToolExecutions: 0, emptied: false };
  }

  const trimmed: ReflectionContent = {
    ...content,
    ...(content.turns === undefined ? {} : { turns }),
    ...(content.tool_executions === undefined ? {} : { tool_executions: toolExecutions }),
  };
  const emptied =
    (trimmed.turns?.length ?? 0) === 0 &&
    (trimmed.tool_executions?.length ?? 0) === 0 &&
    (trimmed.observations?.length ?? 0) === 0;

  return { content: trimmed, trimmedTurns, trimmedToolExecutions, emptied };
}
