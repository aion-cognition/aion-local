import { randomUUID } from 'node:crypto';

import { legacyCoverageEdgeId } from './legacy-coverage.js';
import type { NarrativeDeps } from './narratives.js';
import { attachContentVectors } from './vectors.js';
import {
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import { NARRATIVE_PUBLISHED_BY } from '../../infrastructure/graph/narrative-families.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import {
  LegacyPublicationDeferred,
  type LegacyNarrativeFence,
} from '../domain/legacy-narrative-fence.js';
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
export type NarrativeGraphWrite = Pick<
  NarrativeWrite,
  'narrativeId' | 'sessionId' | 'span' | 'now' | 'occurredAt'
> & {
  readonly operationId: string;
  readonly decision: Pick<NarrativeDecision, 'version' | 'coverageKey' | 'episodeIds'>;
  readonly output: Pick<GroundedNarrative, 'summary' | 'narrative' | 'citations' | 'kept'>;
  readonly source: Pick<NarrativeSource, 'coverage'>;
};

function narrativeProperties(input: NarrativeGraphWrite): GraphProperties {
  return {
    [NARRATIVE_PUBLISHED_BY]: input.operationId,
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
    [NARRATIVE_PROPERTIES.family]: 'legacy_session_overview',
  };
}

/**
 * The node and its provenance edges in one transaction. `occurred_at` is the end of the span
 * it covers, so recency ranks a narrative with the freshest experience it compresses rather
 * than with the oldest. Edge counts are zero: these are structural facts, not observations,
 * so a repeat write moves nothing.
 */
export async function writeNarrativeInTransaction(
  tx: GraphTransaction,
  input: NarrativeGraphWrite,
): Promise<void> {
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
      id: legacyCoverageEdgeId(episodeId, input.narrativeId),
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
}

/**
 * Lineage, not deletion: the old version stays readable and time travel still returns it. Its
 * summarization edges close with it, in the same transaction, so no reader ever sees a
 * superseded version still summarizing the session. Nothing else about it moves: the node, its
 * citations, its `DERIVES_FROM` edge, and the `SUPERSEDES` link naming its replacement all stay
 * open. Without this the episodes of a session that narrates repeatedly keep one live edge per
 * dead version, and every traversal through those episodes pays for all of them.
 *
 * A crash between the two writes leaves nothing half-done, since they commit together, and a
 * repeat of the whole call is a no-op: the close `coalesce`s and the edge statement only
 * matches what is still open. `narrative_cleanup` repairs the residue of any close that ran
 * before this one existed.
 */
export async function closeSupersededInTransaction(
  tx: GraphTransaction,
  decision: NarrativeDecision,
  narrativeId: string,
  now: Date,
  occurredAt: Date,
): Promise<void> {
  const superseded = decision.supersedes.filter((oldId) => oldId !== narrativeId);
  if (superseded.length === 0) {
    return;
  }

  for (const oldId of superseded) {
    await supersedeInTransaction(tx, {
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

  await closeNarrativeEdgesInTransaction(tx, {
    narrativeIds: superseded,
    validUntil: occurredAt,
    txUntil: now,
  });
}

/** The caller supplies the dependency captured before it began reading or synthesizing. */
export async function writeNarrative(
  deps: NarrativeDeps,
  input: NarrativeWrite,
  fence?: LegacyNarrativeFence,
): Promise<void> {
  if (deps.publications === undefined || fence === undefined) {
    throw new Error('legacy narration requires a composed publisher and run-start fence');
  }
  const outcome = await deps.publications.publish({
    kind: 'legacy_narrative_publish',
    operationId: `legacy-narrative:${randomUUID()}`,
    payload: {
      mode: 'publish',
      sessionId: input.sessionId,
      nodeId: input.narrativeId,
      coverageKey: input.decision.coverageKey,
      version: input.decision.version,
      sourceIds: input.decision.episodeIds,
      summary: input.output.summary,
      narrative: input.output.narrative,
      citations: input.output.citations,
      kept: input.output.kept,
      coverage: input.source.coverage,
      spanStart: input.span.start?.toISOString() ?? null,
      spanEnd: input.span.end?.toISOString() ?? null,
      occurredAt: input.occurredAt.toISOString(),
      readAt: input.now.toISOString(),
      fence,
    },
  });
  if (outcome.status !== 'acknowledged') {
    throw new LegacyPublicationDeferred(outcome.reason);
  }
}

export async function closeSuperseded(
  deps: NarrativeDeps,
  decision: NarrativeDecision,
  narrativeId: string,
  now: Date,
  occurredAt: Date,
  fence?: LegacyNarrativeFence,
): Promise<void> {
  if (decision.supersedes.length === 0) {
    return;
  }
  if (deps.publications === undefined || fence === undefined) {
    throw new Error('legacy repair requires a composed publisher and run-start fence');
  }
  const outcome = await deps.publications.publish({
    kind: 'legacy_narrative_publish',
    operationId: `legacy-repair:${randomUUID()}`,
    payload: {
      mode: 'repair',
      sessionId: fence.familyDependency.id,
      nodeId: narrativeId,
      coverageKey: decision.coverageKey,
      version: decision.version,
      sourceIds: decision.episodeIds,
      summary: '',
      narrative: '',
      citations: [],
      kept: 0,
      coverage: 0,
      spanStart: null,
      spanEnd: null,
      occurredAt: occurredAt.toISOString(),
      readAt: now.toISOString(),
      fence,
    },
  });
  if (outcome.status !== 'acknowledged') {
    throw new LegacyPublicationDeferred(outcome.reason);
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
