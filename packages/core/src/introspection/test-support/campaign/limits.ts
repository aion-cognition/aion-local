import type { ArchiveRecordShape } from '../../../infrastructure/sqlite/campaign-archive-reads.js';
import { checkLimit, type LimitReport } from '../../domain/campaign-distribution.js';

/**
 * The proposed bounds the stored corpus is checked against.
 *
 * Only the ones whose subject is already stored are here. A limit on a record shape nothing
 * writes yet has no corpus to be measured against, and a report of zero exceedances over zero
 * records reads as a bound that passed rather than as a bound nobody checked, so the caller
 * omits the whole section when the archive did not answer.
 */
export const REQUEST_LIMITS = {
  turns: 200,
  observations: 64,
  toolExecutions: 64,
  payloadBytes: 512 * 1024,
  rawPayloadBytes: 256 * 1024,
} as const;

export function archiveLimitReports(
  shapes: readonly ArchiveRecordShape[],
): Readonly<Record<string, LimitReport>> {
  const keyed = (pick: (shape: ArchiveRecordShape) => number): { key: string; value: number }[] =>
    shapes.map((shape) => ({ key: shape.episodeId, value: pick(shape) }));

  return {
    request_turns: checkLimit(
      keyed((shape) => shape.turnCount),
      REQUEST_LIMITS.turns,
      'turns',
    ),
    request_observations: checkLimit(
      keyed((shape) => shape.observationCount),
      REQUEST_LIMITS.observations,
      'observations',
    ),
    request_tool_executions: checkLimit(
      keyed((shape) => shape.toolExecutionCount),
      REQUEST_LIMITS.toolExecutions,
      'tool executions',
    ),
    request_payload_bytes: checkLimit(
      keyed((shape) => shape.payloadBytes),
      REQUEST_LIMITS.payloadBytes,
      'bytes',
    ),
    raw_source_bytes: checkLimit(
      keyed((shape) => shape.payloadBytes),
      REQUEST_LIMITS.rawPayloadBytes,
      'bytes',
    ),
  };
}
