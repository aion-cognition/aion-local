import { loadEpisodeContext } from '../../../infrastructure/graph/episode-context.js';
import { findFactBearingEpisodesOldestFirst } from '../../../infrastructure/graph/retro-supersession-queries.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  SupersessionStage,
  SUPERSESSION_STAGE_NAME,
} from '../../../reflection/application/stages/supersession.js';
import { stageLedgerKey, type StageContext } from '../../../reflection/domain/stage.js';
import { PIPELINE_VERSION } from '../../../reflection/domain/version.js';
import type { IntrospectionOperation, OperationOutcome } from '../../domain/operation.js';

/**
 * The backlog this operation drains: episodes reflected before the supersession stage joined
 * the pipeline (or before its subject-identity fix landed) carry facts that were never
 * compared against what came after them. `reflection:stage:{version}:supersession:{episodeId}` is
 * the same key the live orchestrator sets the moment its own supersession stage finishes an
 * episode, so a fact-bearing episode missing it is, by definition, one the fix never reached.
 *
 * The sweep is deliberately a query over the true backlog rather than a stored cursor: each
 * run reads the oldest window of fact-bearing episodes, filters out whatever the ledger
 * already marks as swept (the live pipeline included, since new episodes earn the key the
 * ordinary way and this operation never revisits them), and judges the oldest unswept ones up
 * to its batch bound. The backlog only shrinks, so this converges without any state of its own
 * beyond the ledger the orchestrator already writes.
 */

export const RETRO_JUDGMENT_SWEEP_OPERATION = 'retro_judgment_sweep';

/** Standing relevance, like `memory_decay`: a backlog has no gauge of its own, only waiting time. */
export const RETRO_SWEEP_STANDING_RELEVANCE = 0.1;

/** How far past one batch the candidate window reaches, so a batch's worth of already-swept episodes does not stall a tick. */
const RETRO_SWEEP_SCAN_FACTOR = 10;
/** The scan itself stays bounded regardless of how large the batch configures. */
const RETRO_SWEEP_SCAN_CEILING = 500;

export function retroJudgmentSweepOperation(): IntrospectionOperation {
  return {
    name: RETRO_JUDGMENT_SWEEP_OPERATION,
    bucket: 'day',
    relevance: () => RETRO_SWEEP_STANDING_RELEVANCE,
    run: async (ctx): Promise<OperationOutcome> => {
      const batch = ctx.config.maintenance.retroSupersessionBatch;
      const scanLimit = Math.min(RETRO_SWEEP_SCAN_CEILING, batch * RETRO_SWEEP_SCAN_FACTOR);
      const candidates = await findFactBearingEpisodesOldestFirst(ctx.driver, scanLimit);
      const unswept = candidates.filter(
        (id) =>
          !isLedgerApplied(ctx.db, stageLedgerKey(PIPELINE_VERSION, SUPERSESSION_STAGE_NAME, id)),
      );
      const toJudge = unswept.slice(0, batch);

      const stage = new SupersessionStage({
        model: ctx.config.models.reflect,
        timeoutMs: ctx.config.reflection.stageTimeoutMs,
        mode: 'propose',
        autoConfidence: ctx.config.reflection.supersedeAutoConfidence,
        neighborThreshold: ctx.config.reflection.supersedeNeighborThreshold,
        maxSubjects: ctx.config.reflection.maxSupersessionSubjects,
        maxNeighbors: ctx.config.reflection.maxContradictionNeighbors,
        maxJudgments: ctx.config.reflection.maxContradictionJudgments,
      });

      let judged = 0;
      let proposals = 0;
      for (const episodeId of toJudge) {
        if (ctx.signal.aborted) {
          break;
        }
        const episode = await loadEpisodeContext(ctx.driver, episodeId);
        if (episode === undefined) {
          continue;
        }
        const stageCtx: StageContext = {
          driver: ctx.driver,
          db: ctx.db,
          provider: ctx.provider,
          episodeId,
          episode,
          logger: ctx.logger,
          now: ctx.now,
          occurredAt: episode.occurredAt ?? ctx.now,
          pipelineVersion: PIPELINE_VERSION,
        };
        const outcome = await stage.run(stageCtx);
        judged += 1;
        proposals += outcome.counts?.supersessionProposals ?? 0;
        // Mirrors the orchestrator's own per-stage gate: only a run with nothing left to
        // retry earns the key, so a transient model or write failure leaves the episode in
        // the backlog for the next tick instead of skipping it forever.
        if (outcome.status !== 'failed') {
          markLedgerApplied(
            ctx.db,
            stageLedgerKey(PIPELINE_VERSION, SUPERSESSION_STAGE_NAME, episodeId),
            { status: outcome.status, summary: outcome.summary },
          );
        }
      }

      const remaining = unswept.length - judged;
      const floor = candidates.length >= scanLimit ? ' (at least, within this scan window)' : '';
      return {
        status: proposals === 0 ? 'noop' : 'applied',
        itemsProcessed: judged,
        itemsAffected: proposals,
        detail:
          `${String(judged)} episode(s) judged, ${String(proposals)} proposal(s) raised, ` +
          `${String(Math.max(0, remaining))} remaining${floor}`,
      };
    },
  };
}
