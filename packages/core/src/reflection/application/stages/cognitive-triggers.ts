import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { contentVectors } from '../../../infrastructure/graph/seed-queries.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import type { StageContext } from '../../domain/stage.js';

/**
 * The two trigger fields an intention is written with, gathered outside the extraction call.
 * Neither costs a model call: the date is a field the one extraction call already returns, and
 * the situation vector is the source episode's own `content_vec`, read back from the graph.
 */

/**
 * The date the extractor said the intention waits for, or nothing. It arrives as whatever the
 * model returned, so it is narrowed the way every other key field is: an unparseable answer
 * costs the intention its temporal trigger and never the intention itself.
 *
 * The parse is deliberately strict about what it accepts as a date and says nothing about the
 * episode's words. Reading a moment out of prose is the extraction call's job, which is where
 * the model already is; this only decides whether what came back is a date at all.
 */
export function narrowTriggerAfter(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed;
}

/**
 * The source episode's content vector, which every intention this run writes carries as its
 * situation trigger. One read for the whole run, because every node the run writes comes from
 * one episode.
 *
 * Absent is a normal answer twice over: the episode's vector is still pending on an intake whose
 * embedding failed, and a run that cannot reach the graph for this is a run whose intentions
 * simply carry no situation trigger. Neither is worth failing extraction over, so the read is
 * best-effort and the caller writes what it got.
 */
export async function episodeTriggerVector(ctx: StageContext): Promise<Vector | undefined> {
  try {
    const rows = await contentVectors(ctx.driver, {
      ids: [ctx.episodeId],
      mode: withCurrency(ctx.now),
    });
    const vector = rows[0]?.vector;
    if (vector === undefined || vector.length === 0) {
      return undefined;
    }
    return vector;
  } catch (error) {
    ctx.logger.warn(
      { err: error, episodeId: ctx.episodeId },
      'cognitive extraction: episode vector read failed, intentions carry no situation trigger',
    );
    return undefined;
  }
}
