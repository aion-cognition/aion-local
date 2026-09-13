import { recordDerivedEvidence } from './derived-evidence.js';
import { buildMessages, SYNTHESIS_JSON_SCHEMA } from './synthesis-prompt.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { describeError, isAbortError } from '../../../infrastructure/errors.js';
import { normalizeCognitiveText } from '../../../infrastructure/graph/cognitive-text.js';
import { DERIVES_FROM_TYPE } from '../../../infrastructure/graph/narrative-queries.js';
import { withCurrency } from '../../../infrastructure/graph/read-modes.js';
import { contentVectors } from '../../../infrastructure/graph/seed-queries.js';
import { readAtRevision } from '../../../infrastructure/graph/selected-reading.js';
import {
  findChangedFactMemories,
  findPriorConclusions,
  findReconsideredConclusions,
  findSynthesisNeighbours,
  writeSynthesis,
  type SynthesisCandidate,
} from '../../../infrastructure/graph/synthesis-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { Vector } from '../../../infrastructure/providers/types.js';
import { committedIncidenceForNodesAt } from '../../../infrastructure/sqlite/committed-evidence.js';
import { isLedgerApplied, markLedgerApplied } from '../../../infrastructure/sqlite/ops-ledger.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';
import {
  parseSynthesisAnswer,
  plannedConclusions,
  synthesisNeighbourhoodKey,
  type PlannedConclusion,
  type PriorConclusion,
  type SynthesisPremise,
} from '../../domain/synthesis.js';
import { derivedNode, owesBirthEstablishment, type DerivedNode } from '../derived-node-evidence.js';

/**
 * One structured-output call per episode drawing conclusions ACROSS memories, where the graph
 * exposes a pattern, a tension or an open question that no single memory states.
 *
 * The pass is incremental by construction. It nominates around what this run just changed, then
 * reaches out of the episode two ways: by content vector, and along the supersession edges this
 * run wrote, which carry a correction to the conclusions already drawn over what it corrected. A
 * cosine cannot find the second kind, since a correction may be worded nothing like the claim it
 * corrects. Either way the neighbourhood is the new evidence plus what it touches rather than the
 * whole history. `reflection/domain/synthesis.ts` owns the key it is recorded under, and that key
 * moves the moment any premise the pass read is revised, so a pass that concluded nothing is
 * asked again exactly when the evidence changes.
 *
 * The conclusions are full graph citizens: embedded here, so activation and resonance reach
 * them, and hung on `DERIVES_FROM` edges the context-vector stage that follows this one closes
 * over. Their durable provenance is the sources behind their premises, recorded the way a
 * consolidation records the sources behind its members.
 */

export const SYNTHESIS_STAGE_NAME = 'synthesis';

export type SynthesisStageOptions = {
  readonly model: string;
  readonly timeoutMs: number;
  /** Conclusions one pass may write. Past it the pass declines rather than truncating quietly. */
  readonly maxConclusions: number;
  /** The cosine a memory from another episode has to reach to join the neighbourhood. */
  readonly neighbourThreshold: number;
  /** Per-changed-memory cap on the neighbours the read returns. */
  readonly maxNeighbours: number;
};

/** Reasoning is the whole point of this call, so unlike extraction it asks for it. */
const SYNTHESIS_TEMPERATURE = 0;

function toPremise(candidate: SynthesisCandidate): SynthesisPremise {
  return {
    id: candidate.id,
    label: candidate.label,
    text: candidate.text,
    revision: candidate.revision,
  };
}

/** One row per id, the first nomination of it winning, so a memory two legs reach is shown once. */
function distinctById<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

type Nomination = {
  readonly premises: readonly SynthesisPremise[];
  readonly priors: readonly PriorConclusion[];
};

export class ReflectiveSynthesisStage implements ReflectionStage {
  readonly name = SYNTHESIS_STAGE_NAME;
  readonly #options: SynthesisStageOptions;

  constructor(options: Partial<SynthesisStageOptions> = {}) {
    this.#options = {
      model: DEFAULTS.anthropic.model,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      maxConclusions: DEFAULTS.reflection.maxSynthesisConclusions,
      neighbourThreshold: DEFAULTS.reflection.synthesisNeighbourThreshold,
      maxNeighbours: DEFAULTS.reflection.maxSynthesisNeighbours,
      ...options,
    };
  }

  /**
   * The options this instance actually runs on. The threshold and both caps reach the stage only
   * through construction, so without a reader a build that dropped the wiring draws conclusions
   * under the constructor defaults while the deployment's own numbers sit unread.
   */
  describe(): SynthesisStageOptions {
    return this.#options;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const nominated = await this.#nominate(ctx);
    if ('summary' in nominated) {
      return nominated.outcome;
    }
    const { premises, priors } = nominated;

    // The key is folded from what this pass read, before anything is generated, so the mark it
    // leaves is a statement about that exact reading and nothing else.
    const key = synthesisNeighbourhoodKey(ctx.pipelineVersion, premises, priors);
    if (isLedgerApplied(ctx.db, key)) {
      return {
        status: 'skipped',
        summary: 'this neighbourhood was already read at these revisions',
        settled: {
          disposition: 'complete',
          reason: 'effects_already_recorded',
          proof: { premises: premises.length, priors: priors.length },
        },
      };
    }

    // Read before the call, because this is the binding a conclusion's record has to name: the
    // captures standing behind the premises at the moment the model was shown them. A read taken
    // once the answer is back describes a graph the model never saw.
    const sources = this.#sourcesBehind(ctx, premises);

    const deadline = deadlineFor(this.#options.timeoutMs, ctx.signal);
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        surface: 'synthesis',
        model: this.#options.model,
        messages: buildMessages(premises, priors),
        schema: SYNTHESIS_JSON_SCHEMA,
        temperature: SYNTHESIS_TEMPERATURE,
        think: true,
        signal: deadline.signal,
      });
    } catch (error) {
      return {
        status: 'failed',
        summary: `synthesis call ${isAbortError(error) ? 'timed out' : 'failed'}: ${describeError(error)}`,
      };
    } finally {
      deadline.clear();
    }

    const answer = parseSynthesisAnswer(raw);
    if (answer.status === 'unusable') {
      return { status: 'failed', summary: 'synthesis returned no list of conclusions' };
    }
    const plan = plannedConclusions(answer.conclusions, {
      premises,
      priors,
      max: this.#options.maxConclusions,
    });
    if (plan.conclusions.length === 0) {
      // A pass that read the neighbourhood and drew nothing has answered for this reading, and
      // the mark says so. It does not silence the neighbourhood: the key carries every premise
      // revision, so the next change to any of them asks the question again.
      markLedgerApplied(ctx.db, key, {
        conclusions: 0,
        refused: plan.refused.length,
        dropped: answer.dropped,
      });
      const declined = [
        plan.refused.length === 0 ? '' : `${String(plan.refused.length)} refused`,
        answer.dropped === 0 ? '' : `${String(answer.dropped)} unreadable`,
      ].filter((part) => part.length > 0);
      return {
        status: 'ok',
        summary: `no conclusion across ${String(premises.length)} memories${
          declined.length === 0 ? '' : `, ${declined.join(', ')}`
        }`,
        counts: { synthesis: 0 },
      };
    }

    return await this.#write(ctx, {
      key,
      conclusions: plan.conclusions,
      premises,
      priors,
      sources,
      dropped: answer.dropped,
      refused: plan.refused,
    });
  }

  /**
   * The neighbourhood, or the reason there is none.
   *
   * Every skip here is a reading of the graph rather than a failure, and each names what it
   * read: no changed memory means cognitive extraction wrote nothing this run, and no neighbour
   * beside no corrected conclusion means the changed memories reach nothing outside their own
   * episode, which is a normal state for the first episode about a subject.
   */
  async #nominate(
    ctx: StageContext,
  ): Promise<Nomination | { summary: true; outcome: StageOutcome }> {
    let changed: readonly SynthesisCandidate[];
    try {
      changed = await findChangedFactMemories(ctx.driver, {
        episodeId: ctx.episodeId,
        now: ctx.now,
      });
    } catch (error) {
      return {
        summary: true,
        outcome: {
          status: 'failed',
          summary: `could not read this run's fact memories: ${describeError(error)}`,
        },
      };
    }
    if (changed.length === 0) {
      return {
        summary: true,
        outcome: {
          status: 'skipped',
          summary: 'this run changed no fact-bearing memory to synthesise over',
          retryable: true,
          settledOnUpstream: {
            disposition: 'not_applicable',
            reason: 'proved_empty_input',
            proof: { changedMemories: 0 },
          },
        },
      };
    }

    try {
      const seeds = await contentVectors(ctx.driver, {
        ids: changed.map((candidate) => candidate.id),
        mode: withCurrency(ctx.now),
      });
      const neighbours =
        seeds.length === 0
          ? []
          : await findSynthesisNeighbours(ctx.driver, {
              episodeId: ctx.episodeId,
              threshold: this.#options.neighbourThreshold,
              neighbourLimit: this.#options.maxNeighbours,
              now: ctx.now,
              seeds: seeds.map((seed) => ({ id: seed.id, vector: seed.vector })),
            });
      // What this run corrected, and the conclusions the graph already hangs off what it
      // corrected. A correction is free to be worded nothing like the claim it corrects, so
      // the cosine above is the wrong instrument for finding those and the edge is the right one.
      const reconsidered = await findReconsideredConclusions(ctx.driver, {
        changedIds: changed.map((candidate) => candidate.id),
        limit: this.#options.maxNeighbours,
      });
      if (neighbours.length === 0 && reconsidered.length === 0) {
        return {
          summary: true,
          outcome: {
            status: 'skipped',
            summary: 'the changed memories reach nothing outside their own episode',
            settled: {
              disposition: 'complete',
              reason: 'pass_produced_nothing',
              proof: { changedMemories: changed.length, neighbours: 0 },
            },
          },
        };
      }
      const premises = distinctById([
        ...changed,
        ...neighbours,
        ...reconsidered.flatMap((entry) => entry.evidence),
      ]).map(toPremise);
      const drawn = await findPriorConclusions(
        ctx.driver,
        premises.map((premise) => premise.id),
      );
      const priors = distinctById([...drawn, ...reconsidered.map((entry) => entry.prior)]);
      return { premises, priors };
    } catch (error) {
      return {
        summary: true,
        outcome: {
          status: 'failed',
          summary: `could not read the synthesis neighbourhood: ${describeError(error)}`,
        },
      };
    }
  }

  /**
   * The conclusions, their premises, their revisions, and the record of what stands behind them.
   *
   * The ledger mark lands after the evidence record, not after the graph write: a conclusion
   * whose sources nobody counted is one every judge asked about abstains on, and marking the key
   * before that record exists is what would make the miss permanent.
   */
  async #write(
    ctx: StageContext,
    input: {
      readonly key: string;
      readonly conclusions: readonly PlannedConclusion[];
      readonly premises: readonly SynthesisPremise[];
      readonly priors: readonly PriorConclusion[];
      /** The sources behind each premise, read before the call. */
      readonly sources: ReadonlyMap<string, readonly string[]>;
      readonly dropped: number;
      readonly refused: readonly string[];
    },
  ): Promise<StageOutcome> {
    const { conclusions, refused } = input;
    const premiseText = new Map(input.premises.map((premise) => [premise.id, premise.text]));
    // Bound off the same rows `buildMessages` renders, so the write re-checks what was shown.
    const readAt = new Map(
      [...input.premises, ...input.priors].map((row) => [row.id, readAtRevision(row)] as const),
    );
    let vectors: readonly Vector[] = [];
    try {
      vectors = await ctx.provider.embed(conclusions.map((entry) => entry.text));
    } catch (error) {
      ctx.logger.warn(
        { err: error, episodeId: ctx.episodeId },
        'synthesis: embedding failed, writing conclusions without content vectors',
      );
    }

    const derived: DerivedNode[] = [];
    let written = 0;
    let replaced = 0;
    let contested = 0;
    let moved: readonly string[] = [];
    let writeError: unknown;
    for (const [index, conclusion] of conclusions.entries()) {
      try {
        const premiseTexts = conclusion.premiseIds.map((id) => premiseText.get(id) ?? id);
        const prior =
          conclusion.outcome.kind === 'new' ? undefined : readAt.get(conclusion.outcome.priorId);
        const result = await writeSynthesis(ctx.driver, {
          text: conclusion.text,
          textNorm: normalizeCognitiveText(conclusion.text),
          premiseIds: conclusion.premiseIds,
          premiseTexts,
          confidence: conclusion.confidence,
          rationale: conclusion.rationale,
          ...(vectors[index] === undefined ? {} : { contentVector: vectors[index] }),
          ...(conclusion.outcome.kind === 'new'
            ? {}
            : {
                revises: {
                  priorId: conclusion.outcome.priorId,
                  kind: conclusion.outcome.kind,
                },
              }),
          selected: {
            premises: conclusion.premiseIds
              .map((id) => readAt.get(id))
              .filter((row) => row !== undefined),
            ...(prior === undefined ? {} : { prior }),
          },
          occurredAt: ctx.occurredAt,
          now: ctx.now,
        });
        const { moved: stale } = result;
        if (stale !== undefined) {
          moved = stale;
          break;
        }
        written += 1;
        if (result.replacedId !== undefined) {
          replaced += 1;
        }
        if (result.alternativeToId !== undefined) {
          contested += 1;
        }
        const minted = result.created || owesBirthEstablishment(ctx.db, result.id);
        for (const sourceId of this.#sourcesOf(input.sources, conclusion.premiseIds)) {
          derived.push(
            derivedNode({
              nodeId: result.id,
              role: 'extraction',
              relationType: DERIVES_FROM_TYPE,
              sourceId,
              minted,
            }),
          );
        }
      } catch (error) {
        writeError = error;
        break;
      }
    }

    const recorded = await recordDerivedEvidence(ctx, 'synthesis', derived);
    if (recorded !== undefined) {
      return recorded;
    }
    if (writeError !== undefined) {
      return {
        status: 'failed',
        summary: `synthesis wrote ${String(written)} of ${String(conclusions.length)} conclusion(s) before a graph write failed: ${describeError(writeError)}`,
        ...(written > 0 ? { counts: { synthesis: written } } : {}),
      };
    }
    if (moved.length > 0) {
      // The conclusion was about a reading that stopped being the reading while the model was
      // answering. The key is left open and nothing is settled, so the next pass asks about the
      // memories as they now stand rather than publishing an answer to a question that moved.
      return {
        status: 'skipped',
        summary:
          `synthesis wrote ${String(written)} of ${String(conclusions.length)} conclusion(s); ` +
          `${String(moved.length)} selected memory/ies moved during generation`,
        retryable: true,
        ...(written > 0 ? { counts: { synthesis: written } } : {}),
      };
    }
    if (derived.length === 0) {
      // Every premise's sources are uncounted, so nothing durable could be recorded and the
      // conclusion stands in the graph with no reachable lineage. The key stays open.
      return {
        status: 'failed',
        summary: `synthesis wrote ${String(written)} conclusion(s) whose premises name no committed source`,
        counts: { synthesis: written },
      };
    }

    markLedgerApplied(ctx.db, input.key, {
      conclusions: written,
      replaced,
      contested,
      dropped: input.dropped,
    });
    const lineage = [
      replaced === 0 ? '' : `${String(replaced)} replacing an earlier reading`,
      contested === 0 ? '' : `${String(contested)} standing beside one`,
      refused.length === 0 ? '' : `${String(refused.length)} refused`,
    ].filter((part) => part.length > 0);
    return {
      status: 'ok',
      summary: `drew ${String(written)} conclusion(s)${lineage.length === 0 ? '' : `, ${lineage.join(', ')}`}`,
      counts: { synthesis: written },
    };
  }

  /**
   * The captures each premise was extracted from, which is what the records can say stands
   * behind a conclusion drawn from them.
   *
   * A synthesis has no source of its own: it is derived from claims rather than from a capture,
   * the way a consolidation is, so the sources it can name are its premises' sources. Only open
   * extraction incidence counts, because those are the occurrences a judge shown this conclusion
   * is entitled to.
   *
   * Keyed by premise rather than flattened, so the binding taken before the call can still be
   * narrowed to the premises a given conclusion actually cited.
   */
  #sourcesBehind(
    ctx: StageContext,
    premises: readonly SynthesisPremise[],
  ): ReadonlyMap<string, readonly string[]> {
    const ids = premises.map((premise) => premise.id);
    const byPremise = new Map<string, string[]>();
    for (const row of committedIncidenceForNodesAt(ctx.db, ids, undefined)) {
      if (row.currency !== 'open' || row.role !== 'extraction') {
        continue;
      }
      const held = byPremise.get(row.nodeId) ?? [];
      held.push(row.sourceId);
      byPremise.set(row.nodeId, held);
    }
    return byPremise;
  }

  /** The sources behind one conclusion's own premises, out of the binding the pass read. */
  #sourcesOf(
    sources: ReadonlyMap<string, readonly string[]>,
    premiseIds: readonly string[],
  ): readonly string[] {
    return [...new Set(premiseIds.flatMap((id) => sources.get(id) ?? []))].sort();
  }
}
