import { loadEntityDedupDetails } from '../../../infrastructure/graph/entity-dedup-queries.js';
import { fetchHygieneEpisodeProvenance } from '../../../infrastructure/graph/hygiene-provenance-queries.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  listEntityMergeProposals,
  resolveEntityMergeProposal,
  type EntityMergeProposal,
} from '../../../infrastructure/sqlite/entity-merge-proposals.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import {
  listSupersessionProposals,
  resolveSupersessionProposal,
  type SupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';
import {
  classifyHygieneAge,
  hygieneAgeDays,
  hygieneLedgerKey,
  isPastHygieneHorizon,
  proposalHygieneRelevance,
  type HygieneAgeClass,
  type HygieneHorizons,
  type HygieneProposalTable,
} from '../../domain/proposal-hygiene.js';
import { judgeHygienePair } from '../proposal-hygiene-judge.js';
import { sweepStaleMergeProposals } from '../stale-merge-sweep.js';

/**
 * Ages a proposal out of the review queue once nobody has acted on it inside its horizon.
 * Every dismissal is a `resolve()` plus a permanent ledger stamp naming the class, the reason,
 * and the pair, so precision is judged from the real record later rather than from a shadow
 * count kept in advance. `aion proposals reopen` is the undo; this operation never deletes a
 * row and never touches the graph, only the two sqlite proposal tables and the ledger.
 */

export const PROPOSAL_HYGIENE_OPERATION = 'proposal_hygiene';

/** Independent of the judge budget below: the ceiling on how many open rows one tick reads at all. */
const SCAN_CEILING = 200;

type HygieneCandidate =
  | { readonly table: 'supersession'; readonly proposal: SupersessionProposal }
  | { readonly table: 'entity_merge'; readonly proposal: EntityMergeProposal };

function loadCandidates(db: SqliteHandle): readonly HygieneCandidate[] {
  const supersessions: HygieneCandidate[] = listSupersessionProposals(db)
    .filter((proposal) => proposal.resolvedAt === null)
    .map((proposal) => ({ table: 'supersession', proposal }));
  const merges: HygieneCandidate[] = listEntityMergeProposals(db)
    .filter((proposal) => proposal.resolvedAt === null)
    .map((proposal) => ({ table: 'entity_merge', proposal }));
  return [...supersessions, ...merges]
    .sort((a, b) => Date.parse(a.proposal.createdAt) - Date.parse(b.proposal.createdAt))
    .slice(0, SCAN_CEILING);
}

type HygieneSummary = {
  readonly class: HygieneAgeClass;
  readonly reason: string;
  readonly verdict?: string;
  readonly ageDays: number;
  readonly episodeId: string;
  readonly leftId?: string;
  readonly leftName?: string;
  readonly rightId?: string;
  readonly rightName?: string;
  readonly oldId?: string;
  readonly newId?: string;
};

/** Pair identity goes into the ledger so the record stands alone, without a join back to a live row a reopen can later change. */
function summaryFor(
  candidate: HygieneCandidate,
  ageClass: HygieneAgeClass,
  reason: string,
  verdict: string | undefined,
  ageDays: number,
): HygieneSummary {
  const base = {
    class: ageClass,
    reason,
    ageDays,
    episodeId: candidate.proposal.episodeId,
    ...(verdict === undefined ? {} : { verdict }),
  };
  if (candidate.table === 'entity_merge') {
    return {
      ...base,
      leftId: candidate.proposal.leftId,
      leftName: candidate.proposal.leftName,
      rightId: candidate.proposal.rightId,
      rightName: candidate.proposal.rightName,
    };
  }
  return { ...base, oldId: candidate.proposal.oldId, newId: candidate.proposal.newId };
}

const POLLUTED_REASON =
  'the source episode carried no turns, only tool calls, and this aged past the fast horizon';
const RESIDUE_REASON = 'aged past the residue horizon with no resolution';

/**
 * The one judgment call in this operation, made only for a fuzzy entity-merge pair both
 * sides of which still hold currency: neither verdict merges or resolves the pair any
 * differently, since exact-fold equality stays the only sanctioned auto-apply. `same` still
 * dismisses, with the verdict recorded for a fuzzy-merge lane this substrate does not have
 * yet; a failed or unusable call dismisses nothing; the row is unstamped and retries.
 */
type JudgeReasoned = { readonly reason: string; readonly verdict?: string } | undefined;

/** Whether this call spent one of the run's judge slots, independent of what it decided. */
type ResidueOutcome = { readonly reasoned: JudgeReasoned; readonly consumedJudgeCall: boolean };

async function reasonForOrdinaryResidue(
  candidate: HygieneCandidate,
  ctx: OperationContext,
  judgeBudgetRemaining: number,
): Promise<ResidueOutcome> {
  if (candidate.table === 'supersession') {
    return { reasoned: { reason: RESIDUE_REASON }, consumedJudgeCall: false };
  }
  const { proposal } = candidate;
  const details = await loadEntityDedupDetails(ctx.driver, [proposal.leftId, proposal.rightId]);
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  const bothCurrent =
    byId.get(proposal.leftId)?.current === true && byId.get(proposal.rightId)?.current === true;
  if (!bothCurrent) {
    // The sweep at the top of the run owns this case and has already resolved every row it
    // could see. Reaching it here means the pair went stale inside this run, so the row is
    // left unstamped for the next tick's sweep rather than spending a judge call on a pair
    // with nothing left to merge.
    return { reasoned: undefined, consumedJudgeCall: false };
  }
  if (judgeBudgetRemaining <= 0) {
    return { reasoned: undefined, consumedJudgeCall: false };
  }
  const verdict = await judgeHygienePair(
    ctx.provider,
    {
      leftName: proposal.leftName,
      leftType: proposal.leftType,
      rightName: proposal.rightName,
      rightType: proposal.rightType,
    },
    {
      model: ctx.config.models.reflect,
      timeoutMs: ctx.config.reflection.stageTimeoutMs,
      signal: ctx.signal,
    },
  );
  if (verdict.status === 'failed' || verdict.status === 'unusable') {
    ctx.logger.info(
      { proposalId: proposal.id, reason: verdict.reason },
      'proposal hygiene judge call unusable; the row is unstamped and retries next cycle',
    );
    return { reasoned: undefined, consumedJudgeCall: true };
  }
  const note =
    verdict.status === 'same'
      ? `judged the same entity (${verdict.reason}); left for a future fuzzy-merge lane, not auto-applied`
      : `judged distinct entities (${verdict.reason})`;
  return { reasoned: { reason: note, verdict: verdict.status }, consumedJudgeCall: true };
}

export function proposalHygieneOperation(): IntrospectionOperation {
  return {
    name: PROPOSAL_HYGIENE_OPERATION,
    bucket: 'day',
    relevance: proposalHygieneRelevance,
    // The median rather than the oldest row's age, because a run that ages one forgotten
    // proposal out moves the oldest and leaves a stalled queue exactly as stalled. An empty
    // queue reads as zero, which is the reading a run that cleared it earned.
    measure: (health) => health.proposals.medianOpenAgeMs ?? 0,
    improves: 'lower',
    run: async (ctx): Promise<OperationOutcome> => {
      if (!ctx.config.maintenance.proposalHygiene) {
        return {
          status: 'noop',
          itemsProcessed: 0,
          itemsAffected: 0,
          detail:
            'proposal hygiene disabled by AION_MAINTENANCE_PROPOSAL_HYGIENE; no rows examined',
        };
      }

      const horizons: HygieneHorizons = {
        pollutedHours: ctx.config.maintenance.hygienePollutedAgeHours,
        residueDays: ctx.config.maintenance.hygieneResidueAgeDays,
      };
      // Before the horizon pass, not after: a pair with a closed side is finished rather than
      // undecided, and resolving it first keeps the judge budget for rows a person could still
      // act on. It rides under the same kill switch as everything else here, so off still means
      // this operation touches no proposal.
      const swept = ctx.signal.aborted
        ? { examined: 0, resolved: 0 }
        : await sweepStaleMergeProposals({
            db: ctx.db,
            driver: ctx.driver,
            logger: ctx.logger,
            now: ctx.now,
          });
      const candidates = loadCandidates(ctx.db);
      const episodeIds = [...new Set(candidates.map((candidate) => candidate.proposal.episodeId))];
      const episodes = await fetchHygieneEpisodeProvenance(ctx.driver, episodeIds);
      let judgeBudgetRemaining = ctx.config.maintenance.hygieneJudgeBatch;

      // Wraps resolve() and the ledger stamp as one commit: a crash between the two would
      // otherwise leave a proposal resolved with no record of why, which is indistinguishable
      // from a bug. better-sqlite3's transactions are synchronous, so nothing here awaits.
      const dismiss = ctx.db.transaction(
        (table: HygieneProposalTable, id: string, resolvedAt: string, summary: HygieneSummary) => {
          const resolved =
            table === 'supersession'
              ? resolveSupersessionProposal(ctx.db, id, resolvedAt)
              : resolveEntityMergeProposal(ctx.db, id, resolvedAt);
          if (resolved) {
            markLedgerApplied(ctx.db, hygieneLedgerKey(table, id), summary);
          }
          return resolved;
        },
      );

      let seen = 0;
      let dismissed = 0;
      for (const candidate of candidates) {
        if (ctx.signal.aborted) {
          break;
        }
        seen += 1;

        const { table, proposal } = candidate;
        const createdAt = new Date(proposal.createdAt);
        const episode = episodes.get(proposal.episodeId);
        const ageClass = classifyHygieneAge(createdAt, episode);
        if (!isPastHygieneHorizon(createdAt, ctx.now, ageClass, horizons)) {
          continue;
        }

        let reasoned: JudgeReasoned;
        if (ageClass === 'tooling_exhaust') {
          reasoned = { reason: POLLUTED_REASON };
        } else {
          const { reasoned: residueReasoned, consumedJudgeCall } = await reasonForOrdinaryResidue(
            candidate,
            ctx,
            judgeBudgetRemaining,
          );
          if (consumedJudgeCall) {
            judgeBudgetRemaining -= 1;
          }
          reasoned = residueReasoned;
        }
        if (reasoned === undefined) {
          continue;
        }

        const ageDays = hygieneAgeDays(createdAt, ctx.now);
        const summary = summaryFor(candidate, ageClass, reasoned.reason, reasoned.verdict, ageDays);
        // Present only on a row a prior hygiene run dismissed and a person then reopened:
        // the stamp never blocks it, and this is what tells the log the row is a repeat.
        const reopened = isLedgerApplied(ctx.db, hygieneLedgerKey(table, proposal.id));
        const resolved = dismiss(table, proposal.id, ctx.now.toISOString(), summary);
        if (!resolved) {
          ctx.logger.info(
            { proposalId: proposal.id, table },
            'proposal hygiene lost the race: the row was already resolved',
          );
          continue;
        }
        dismissed += 1;
        ctx.logger.info(
          { proposalId: proposal.id, table, class: ageClass, reason: reasoned.reason, reopened },
          'proposal hygiene dismissed a stale proposal',
        );
      }

      const affected = dismissed + swept.resolved;
      return {
        status: affected === 0 ? 'noop' : 'applied',
        // The rows the sweep resolved are gone from the horizon pass's own load, so the two
        // counts are of disjoint rows and adding them counts nothing twice.
        itemsProcessed: seen + swept.resolved,
        itemsAffected: affected,
        detail:
          `${String(dismissed)} of ${String(seen)} open proposal(s) dismissed past their hygiene horizon; ` +
          `${String(swept.resolved)} of ${String(swept.examined)} merge proposal(s) resolved with a side that lost currency`,
      };
    },
  };
}
