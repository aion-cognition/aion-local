import type { NarrativeDeps } from './narratives.js';
import { attachContentVectors } from './vectors.js';
import {
  supersede,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import {
  NARRATIVE_GROUNDING,
  SESSION_NARRATIVE_SCOPE,
  type GroundedNarrative,
  type NarrativeDecision,
  type NarrativeSource,
  type NarrativeSpan,
} from '../domain/narrative.js';

/**
 * Everything a session narrative writes to the graph: the node, its provenance edges, the
 * supersession of the version it replaces, and the content vector. Split from the decision path
 * beside it so each file stays inside the module ceiling; nothing here decides anything.
 */

/** Provenance: what produced the node, as distinct from what later reads it. */
export const NARRATIVE_EXTRACTION_METHOD = 'reflection_narrative';

const NARRATIVE_SIGNALS = ['compression'];
const NARRATIVE_PROVENANCE = [NARRATIVE_EXTRACTION_METHOD];

export type NarrativeWrite = {
  readonly narrativeId: string;
  readonly sessionId: string;
  readonly decision: NarrativeDecision;
  readonly output: GroundedNarrative;
  readonly source: NarrativeSource;
  readonly span: NarrativeSpan;
  readonly now: Date;
  /** The end of the span the narrative covers, else the run's world time. */
  readonly occurredAt: Date;
};

/**
 * `summary` is the one-line gist every pack shows; `text` is the narrative body, which is
 * both what `content_fts` indexes and what the pending-vector drain would embed if the
 * embedder is down at close time. Writing the body under `text` is what keeps a narrative
 * that missed its vector recoverable by the ordinary backfill instead of permanently
 * invisible to vector search. `citations` carries the ids every stored sentence cited, which
 * is what makes the claim auditable after the fact.
 */
function narrativeProperties(input: NarrativeWrite): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: input.output.summary,
    [MEMORY_PROPERTIES.text]: input.output.narrative,
    [NARRATIVE_PROPERTIES.citations]: [...input.output.citations],
    [NARRATIVE_PROPERTIES.sentenceCount]: input.output.kept,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [MEMORY_PROPERTIES.sessionId]: input.sessionId,
    [MEMORY_PROPERTIES.extractionMethod]: NARRATIVE_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.scope]: SESSION_NARRATIVE_SCOPE,
    [NARRATIVE_PROPERTIES.version]: input.decision.version,
    [NARRATIVE_PROPERTIES.coverageKey]: input.decision.coverageKey,
    [NARRATIVE_PROPERTIES.coverageCount]: input.decision.episodeIds.length,
    [NARRATIVE_PROPERTIES.coverage]: input.source.coverage,
    [NARRATIVE_PROPERTIES.spanStart]: input.span.start,
    [NARRATIVE_PROPERTIES.spanEnd]: input.span.end,
  };
}

/**
 * The node and its provenance edges in one transaction. `occurred_at` is the end of the span
 * it covers, so recency ranks a narrative with the freshest experience it compresses rather
 * than with the oldest. Edge counts are zero: these are structural facts, not observations,
 * so a repeat write moves nothing.
 */
export async function writeNarrative(deps: NarrativeDeps, input: NarrativeWrite): Promise<void> {
  await inWriteTransaction(deps.driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: 'Narrative',
      id: input.narrativeId,
      now: input.now,
      occurredAt: input.occurredAt,
      properties: narrativeProperties(input),
    });

    await upsertEdgeInTransaction(tx, {
      type: DERIVES_FROM_TYPE,
      sourceId: input.narrativeId,
      targetId: input.sessionId,
      strength: 1,
      confidence: 1,
      signals: NARRATIVE_SIGNALS,
      provenance: NARRATIVE_PROVENANCE,
      count: 0,
      now: input.now,
    });

    for (const episodeId of input.decision.episodeIds) {
      await upsertEdgeInTransaction(tx, {
        type: SUMMARIZED_BY_TYPE,
        sourceId: episodeId,
        targetId: input.narrativeId,
        strength: 1,
        confidence: 1,
        signals: NARRATIVE_SIGNALS,
        provenance: NARRATIVE_PROVENANCE,
        count: 0,
        now: input.now,
      });
    }
  });
}

/** Lineage, not deletion: the old version stays readable and time travel still returns it. */
export async function closeSuperseded(
  deps: NarrativeDeps,
  decision: NarrativeDecision,
  narrativeId: string,
  now: Date,
  occurredAt: Date,
): Promise<void> {
  for (const oldId of decision.supersedes) {
    if (oldId !== narrativeId) {
      await supersede(deps.driver, {
        oldId,
        newId: narrativeId,
        now,
        // An older version stopped covering the session at the replacement's own world time,
        // which is not the moment the rewrite ran.
        validUntil: occurredAt,
        signals: NARRATIVE_SIGNALS,
        provenance: NARRATIVE_PROVENANCE,
      });
    }
  }
}

/**
 * The last step, and the only one allowed to fail without failing the narrative. A node that
 * ends here without its `content_vec` is the same pending-vector marker intake leaves, and
 * the worker's drain resolves it on the next pass.
 */
export async function attachVector(
  deps: NarrativeDeps,
  narrativeId: string,
  text: string,
): Promise<void> {
  try {
    await attachContentVectors(deps.driver, deps.provider, [{ id: narrativeId, text }]);
  } catch (err) {
    deps.logger.warn({ err, narrativeId }, 'narrative vector deferred; the narrative is stored');
  }
}
