import type { Driver } from 'neo4j-driver';
import { createHash } from 'node:crypto';

import {
  BITEMPORAL_PROPERTIES,
  currentOnly,
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from './bitemporal.js';
import { inWriteTransaction, runRead } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, EXTRACTION_TYPE } from './labels.js';
import { DERIVES_FROM_TYPE } from './narrative-queries.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import { ALTERNATIVE_TYPE, SUPERSEDES_TYPE } from './relationships.js';
import { movedSinceRead, type ReadAtRevision } from './selected-reading.js';
import { FACT_NODE_LABELS } from './supersession-queries.js';
import { toGraphInteger, toGraphVector } from './values.js';
import { asCosine } from './vector-indexes.js';
import { vectorInputHash } from '../../reflection/domain/vector-input.js';
import type { Vector } from '../providers/types.js';

/**
 * Reflective synthesis, in the graph: the neighbourhood a pass reads, the conclusions already
 * drawn over it, and the write that stores a new one with its premises.
 *
 * A `Synthesis` node is a conclusion drawn across memories. It carries the premises it rests on
 * and the flag that says it is an inference, for the reason a `Bridge` does: a reader who
 * cannot tell a drawn conclusion from a recorded one cannot correct either. It carries `Memory`
 * like every other content-bearing node, so one vector index covers it, activation reaches it,
 * and decay applies to the edges it hangs on.
 */

export const SYNTHESIS_LABEL = 'Synthesis';

/** Written on a synthesis node's edges, so a conclusion the pipeline drew is separable. */
export const SYNTHESIS_PROVENANCE = 'reflection';
export const SYNTHESIS_SIGNAL = 'reflective_synthesis';

/** The statements the conclusion was drawn from, in the words the pass showed the model. */
export const SYNTHESIS_PREMISES_PROPERTY = 'premises';
/** Always true, and written rather than assumed, the way a bridge writes it. */
export const SYNTHESIS_INFERRED_PROPERTY = 'inferred';
/** The model's own reading of how far the premises carry the conclusion. */
export const SYNTHESIS_CONFIDENCE_PROPERTY = 'confidence';
/** One clause saying why, so the node can answer for itself without a second read. */
export const SYNTHESIS_RATIONALE_PROPERTY = 'rationale';
/** `sole` until a second reading is linked to it, `contested` from then on. */
export const SYNTHESIS_STANDING_PROPERTY = 'standing';

export const SYNTHESIS_STANDINGS = ['sole', 'contested'] as const;

export type SynthesisStanding = (typeof SYNTHESIS_STANDINGS)[number];

/**
 * Node identity: the premise set and the normalized conclusion text.
 *
 * Two passes reading the same memories and drawing the same conclusion write one node, so a
 * retry after a crash between the graph write and its evidence record finds the id it drew
 * rather than minting a second one. The episode is deliberately not in the fold: a conclusion
 * is about the memories, and the episode that triggered the pass is only what made the pass run.
 */
export function deriveSynthesisId(premiseIds: readonly string[], textNorm: string): string {
  const premises = [...new Set(premiseIds)].sort().join('\u0000');
  return createHash('sha256').update(`${premises}\u0000${textNorm}`).digest('hex');
}

export type SynthesisCandidate = {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly revision: number;
  /** The episode the memory was extracted from, so a pass can see it reaches across episodes. */
  readonly sourceId: string;
};

export type SynthesisNeighbourhoodInput = {
  readonly episodeId: string;
  /** The cosine a memory from another episode has to reach to join the neighbourhood. */
  readonly threshold: number;
  /** Per-changed-memory cap on the neighbours the read returns. */
  readonly neighbourLimit: number;
  readonly now: Date;
};

const LIFECYCLE = `coalesce(n.${BITEMPORAL_PROPERTIES.lifecycleRevision}, 1)`;

/**
 * The fact-bearing memories this run just changed: what the episode's cognitive extraction
 * wrote, which is the evidence a synthesis over this neighbourhood is bounded around.
 */
function changedStatement(
  episodeId: string,
  now: Date,
): { cypher: string; parameters: Record<string, unknown> } {
  const fragment = readModeFragment(withCurrency(now), 'n', 'chg');
  return {
    cypher: [
      `MATCH (n)-[:${EXTRACTION_TYPE}]->(e:Episode { id: $episodeId })`,
      `WHERE any(label IN labels(n) WHERE label IN $labels) AND ${currentOnly('n')}`,
      `  AND ${fragment.where}`,
      `RETURN n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
      `       n.${MEMORY_PROPERTIES.text} AS text, ${LIFECYCLE} AS revision, e.id AS source_id`,
      `ORDER BY n.id`,
    ].join('\n'),
    parameters: { episodeId, labels: [...FACT_NODE_LABELS], ...fragment.parameters },
  };
}

/** The memories this run changed, in a stable order so a bounded pass truncates the same way. */
export async function findChangedFactMemories(
  driver: Driver,
  input: { readonly episodeId: string; readonly now: Date },
): Promise<SynthesisCandidate[]> {
  const statement = changedStatement(input.episodeId, input.now);
  return runRead(driver, statement.cypher, statement.parameters, (row) => ({
    id: row.id as string,
    label: row.label as string,
    text: (row.text as string | null) ?? '',
    revision: Number(row.revision ?? 1),
    sourceId: row.source_id as string,
  }));
}

/**
 * The memories from OTHER episodes that the changed ones reach, by content vector.
 *
 * Cross-episode is the whole point: a conclusion drawn inside one episode is what cognitive
 * extraction already writes, and the tension worth synthesising is the one between what was
 * said today and what the substrate held before. A changed memory with no vector yet
 * contributes no seed, which is a normal state rather than a failure.
 */
export async function findSynthesisNeighbours(
  driver: Driver,
  input: SynthesisNeighbourhoodInput & {
    readonly seeds: readonly { id: string; vector: Vector }[];
  },
): Promise<SynthesisCandidate[]> {
  if (input.seeds.length === 0) {
    return [];
  }
  const fragment = readModeFragment(withCurrency(input.now), 'n', 'nbr');
  const cypher = [
    'UNWIND $seeds AS seed',
    `MATCH (n)-[:${EXTRACTION_TYPE}]->(e:Episode)`,
    'WHERE any(label IN labels(n) WHERE label IN $labels)',
    `  AND n.id <> seed.id AND e.id <> $episodeId AND ${currentOnly('n')}`,
    `  AND n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL AND ${fragment.where}`,
    `WITH seed, n, e, ${asCosine(
      `vector.similarity.cosine(n.${MEMORY_PROPERTIES.contentVector}, seed.vector)`,
    )} AS score`,
    'WHERE score >= $threshold',
    'WITH seed, n, e, score ORDER BY seed.id, score DESC',
    'WITH seed.id AS seedId, collect({ node: n, episode: e, score: score })[0..$limit] AS matches',
    'UNWIND matches AS match',
    'WITH match.node AS n, match.episode AS e',
    `RETURN DISTINCT n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
    `       n.${MEMORY_PROPERTIES.text} AS text, ${LIFECYCLE} AS revision, e.id AS source_id`,
    'ORDER BY id',
  ].join('\n');

  return runRead(
    driver,
    cypher,
    {
      episodeId: input.episodeId,
      labels: [...FACT_NODE_LABELS],
      threshold: input.threshold,
      limit: toGraphInteger(input.neighbourLimit),
      seeds: input.seeds.map((seed) => ({ id: seed.id, vector: toGraphVector(seed.vector) })),
      ...fragment.parameters,
    },
    (row) => ({
      id: row.id as string,
      label: row.label as string,
      text: (row.text as string | null) ?? '',
      revision: Number(row.revision ?? 1),
      sourceId: row.source_id as string,
    }),
  );
}

export type PriorConclusionRow = {
  readonly id: string;
  readonly text: string;
  readonly revision: number;
  readonly premiseIds: readonly string[];
};

const PRIOR_CONCLUSIONS = [
  'UNWIND $memoryIds AS memoryId',
  `MATCH (n:${SYNTHESIS_LABEL})-[:${DERIVES_FROM_TYPE}]->(m { id: memoryId })`,
  `WHERE ${currentOnly('n')}`,
  'WITH DISTINCT n',
  `OPTIONAL MATCH (n)-[:${DERIVES_FROM_TYPE}]->(root)`,
  `RETURN n.id AS id, n.${MEMORY_PROPERTIES.text} AS text, ${LIFECYCLE} AS revision,`,
  '       [rootId IN collect(DISTINCT root.id) WHERE rootId IS NOT NULL] AS premise_ids',
  'ORDER BY id',
].join('\n');

/**
 * The conclusions already standing over any of these memories, each with the roots it rests on.
 *
 * The roots travel with the conclusion because that is what the model needs to read it as an
 * interpretation rather than as one more witness. A conclusion whose premises are all in this
 * neighbourhood is the same evidence read twice.
 */
export async function findPriorConclusions(
  driver: Driver,
  memoryIds: readonly string[],
): Promise<PriorConclusionRow[]> {
  if (memoryIds.length === 0) {
    return [];
  }
  return runRead(driver, PRIOR_CONCLUSIONS, { memoryIds: [...new Set(memoryIds)] }, (row) => ({
    id: row.id as string,
    text: (row.text as string | null) ?? '',
    revision: Number(row.revision ?? 1),
    premiseIds: (row.premise_ids as string[] | null) ?? [],
  }));
}

/**
 * What the model was actually shown, carried into the write that publishes its answer.
 *
 * Generation takes seconds to minutes, and everything it read stays writable throughout. Without
 * this the writer knows the ids a conclusion cites and nothing about the state they were cited
 * at, so a premise superseded mid-call is published over as though it still stood. Each row's
 * digest binds the words too: a premise rewritten in place keeps both its id and its revision.
 */
export type SelectedReading = {
  /** The premises the conclusion cites, as the pass selected and showed them. */
  readonly premises: readonly ReadAtRevision[];
  /** The conclusion being revised, as the pass showed it. */
  readonly prior?: ReadAtRevision;
};

/** Everything one conclusion rests on, as one list for the guard to re-read. */
function selectedNodes(selected: SelectedReading | undefined): readonly ReadAtRevision[] {
  if (selected === undefined) {
    return [];
  }
  return [...selected.premises, ...(selected.prior === undefined ? [] : [selected.prior])];
}

/** A prior conclusion the graph itself names as touched, with the evidence still standing under it. */
export type ReconsideredConclusion = {
  readonly prior: PriorConclusionRow;
  /** The prior's own premises that are still current, so the pass can show what it rests on. */
  readonly evidence: readonly SynthesisCandidate[];
};

const RECONSIDERED_CONCLUSIONS = [
  'UNWIND $changedIds AS changedId',
  `MATCH (changed:${BASE_NODE_LABEL} { id: changedId })-[:${SUPERSEDES_TYPE}]->(corrected)`,
  `MATCH (prior:${SYNTHESIS_LABEL})-[:${DERIVES_FROM_TYPE}]->(corrected)`,
  `WHERE ${currentOnly('prior')}`,
  'WITH DISTINCT prior',
  'ORDER BY prior.id',
  'LIMIT $limit',
  `OPTIONAL MATCH (prior)-[:${DERIVES_FROM_TYPE}]->(root)`,
  `OPTIONAL MATCH (root)-[:${EXTRACTION_TYPE}]->(rootEpisode:Episode)`,
  'WITH prior, collect(DISTINCT root.id) AS premise_ids,',
  `     collect(DISTINCT CASE WHEN root IS NOT NULL AND ${currentOnly('root')}`,
  '                        AND any(label IN labels(root) WHERE label IN $labels)',
  '                     THEN { id: root.id,',
  '                            label: [label IN labels(root) WHERE label IN $labels][0],',
  `                            text: root.${MEMORY_PROPERTIES.text},`,
  `                            revision: coalesce(root.${BITEMPORAL_PROPERTIES.lifecycleRevision}, 1),`,
  "                            source_id: coalesce(rootEpisode.id, '') } END) AS evidence",
  `RETURN prior.id AS id, prior.${MEMORY_PROPERTIES.text} AS text,`,
  `       coalesce(prior.${BITEMPORAL_PROPERTIES.lifecycleRevision}, 1) AS revision,`,
  '       premise_ids, evidence',
  'ORDER BY id',
].join('\n');

/**
 * The conclusions a correction reaches through the graph rather than through a cosine.
 *
 * A memory this run superseded may be the premise another conclusion was drawn from, and the
 * `SUPERSEDES` edge says so outright. Wording is what a neighbourhood read measures, and a
 * correction is free to say what it corrects in words that measure nothing like it, so a
 * conclusion known to rest on the corrected memory would otherwise never be shown again.
 *
 * Nomination only: the prior and its standing evidence reach the pass, and what to make of them
 * is the model's. Bounded by `limit`, so a run that corrected a widely cited memory reads a
 * bounded number of the conclusions over it rather than all of them.
 */
export async function findReconsideredConclusions(
  driver: Driver,
  input: {
    readonly changedIds: readonly string[];
    readonly limit: number;
  },
): Promise<ReconsideredConclusion[]> {
  if (input.changedIds.length === 0 || input.limit <= 0) {
    return [];
  }
  return runRead(
    driver,
    RECONSIDERED_CONCLUSIONS,
    {
      changedIds: [...new Set(input.changedIds)],
      labels: [...FACT_NODE_LABELS],
      limit: toGraphInteger(input.limit),
    },
    (row) => ({
      prior: {
        id: row.id as string,
        text: (row.text as string | null) ?? '',
        revision: Number(row.revision ?? 1),
        premiseIds: (row.premise_ids as string[] | null) ?? [],
      },
      evidence: ((row.evidence as Record<string, unknown>[] | null) ?? []).map((entry) => ({
        id: entry.id as string,
        label: entry.label as string,
        text: (entry.text as string | null) ?? '',
        revision: Number(entry.revision ?? 1),
        sourceId: (entry.source_id as string | null) ?? '',
      })),
    }),
  );
}

export type SynthesisWrite = {
  readonly text: string;
  readonly textNorm: string;
  readonly premiseIds: readonly string[];
  /** The premise texts, stored on the node so it can answer for itself without a second read. */
  readonly premiseTexts: readonly string[];
  readonly confidence: number;
  readonly rationale: string;
  /** Absent on an embed failure: the node lands as a pending-vector `:Memory` marker. */
  readonly contentVector?: Vector;
  /** The conclusion this one revises, and what it does to its standing. */
  readonly revises?: { readonly priorId: string; readonly kind: 'replaces' | 'alternative' };
  /**
   * The reading this conclusion rests on. Supplied, the write refuses rather than publishing
   * over evidence that moved; absent, the caller is seeding rather than concluding.
   */
  readonly selected?: SelectedReading;
  readonly occurredAt: Date;
  readonly now: Date;
};

export type SynthesisWriteResult = {
  readonly id: string;
  readonly created: boolean;
  /** The prior conclusion this write closed, where it replaced one. */
  readonly replacedId?: string;
  /** The prior conclusion this write linked as a second reading, where it kept one. */
  readonly alternativeToId?: string;
  /**
   * The selected nodes that moved since the pass read them. Present means nothing was written:
   * neither the conclusion nor the close of its predecessor.
   */
  readonly moved?: readonly string[];
};

/**
 * The node, its premises and its revision, in one transaction.
 *
 * A conclusion without its `DERIVES_FROM` edges is a claim nothing traces, and a replacement
 * whose predecessor stayed open is two current answers to one question. Neither half state is
 * observable. The premise edges carry `count: 0`, so a repeated write is a total no-op.
 *
 * A replacement closes the earlier conclusion through the same bitemporal supersession every
 * other close uses: the old node is never deleted, it stays recall-eligible and time-travel
 * visible, and `(new)-[:SUPERSEDES]->(old)` is what a reader follows back to it. An alternative
 * closes nothing and marks both readings contested, which is what renders the uncertainty.
 *
 * The selected reading is revalidated first, ahead of the node and ahead of any close, and held
 * still from there to the commit. A premise that moved during generation makes the conclusion an
 * assertion about something nobody read, and closing a predecessor on that reading would retire a
 * standing answer in favour of one. Generation itself holds no lock.
 */
export async function writeSynthesis(
  driver: Driver,
  input: SynthesisWrite,
): Promise<SynthesisWriteResult> {
  const id = deriveSynthesisId(input.premiseIds, input.textNorm);
  return inWriteTransaction(driver, async (tx) => {
    const moved = await movedSinceRead(tx, selectedNodes(input.selected), input.now);
    if (moved.length > 0) {
      return { id, created: false, moved };
    }
    const node = await writeStampedDerivedNodeInTransaction(tx, {
      label: SYNTHESIS_LABEL,
      id,
      occurredAt: input.occurredAt,
      now: input.now,
      properties: {
        [MEMORY_PROPERTIES.text]: input.text,
        ...(input.contentVector === undefined
          ? {}
          : {
              [MEMORY_PROPERTIES.contentVector]: toGraphVector(input.contentVector),
              [MEMORY_PROPERTIES.contentVectorHash]: vectorInputHash(input.text),
            }),
        [SYNTHESIS_PREMISES_PROPERTY]: [...input.premiseTexts],
        [SYNTHESIS_INFERRED_PROPERTY]: true,
        [SYNTHESIS_CONFIDENCE_PROPERTY]: input.confidence,
        [SYNTHESIS_RATIONALE_PROPERTY]: input.rationale,
        [SYNTHESIS_STANDING_PROPERTY]: 'sole',
      },
    });

    for (const premiseId of [...new Set(input.premiseIds)].sort()) {
      await upsertEdgeInTransaction(tx, {
        type: DERIVES_FROM_TYPE,
        sourceId: node.id,
        targetId: premiseId,
        strength: input.confidence,
        confidence: input.confidence,
        signals: [SYNTHESIS_SIGNAL],
        provenance: [SYNTHESIS_PROVENANCE],
        count: 0,
        rationale: 'the conclusion was drawn from this memory',
        now: input.now,
      });
    }

    if (input.revises === undefined) {
      return { id: node.id, created: node.created };
    }
    if (input.revises.kind === 'replaces') {
      await supersedeInTransaction(tx, {
        oldId: input.revises.priorId,
        newId: node.id,
        signals: [SYNTHESIS_SIGNAL],
        provenance: [SYNTHESIS_PROVENANCE],
        now: input.now,
      });
      return { id: node.id, created: node.created, replacedId: input.revises.priorId };
    }
    await upsertEdgeInTransaction(tx, {
      type: ALTERNATIVE_TYPE,
      sourceId: node.id,
      targetId: input.revises.priorId,
      strength: input.confidence,
      confidence: input.confidence,
      signals: [SYNTHESIS_SIGNAL],
      provenance: [SYNTHESIS_PROVENANCE],
      count: 0,
      rationale: 'the same memories support both readings',
      now: input.now,
    });
    // Both ends say so, so a reader that reached either one first sees the contest without
    // walking the edge. A standing is a property of the reading, not of the link.
    await tx.run(
      [
        `MATCH (n { id: $newId }) SET n.${SYNTHESIS_STANDING_PROPERTY} = $standing`,
        `WITH n MATCH (p { id: $priorId }) SET p.${SYNTHESIS_STANDING_PROPERTY} = $standing`,
        'RETURN p.id AS id',
      ].join('\n'),
      { newId: node.id, priorId: input.revises.priorId, standing: 'contested' },
      (row) => row.id as string,
    );
    return { id: node.id, created: node.created, alternativeToId: input.revises.priorId };
  });
}

export type StoredSynthesis = {
  readonly id: string;
  readonly text: string;
  readonly premises: readonly string[];
  readonly inferred: boolean;
  readonly confidence: number;
  readonly standing: SynthesisStanding;
  readonly closedAt?: Date;
};

const READ_SYNTHESIS = [
  `MATCH (n:${SYNTHESIS_LABEL} { id: $id })`,
  `RETURN n.id AS id, n.${MEMORY_PROPERTIES.text} AS text,`,
  `       n.${SYNTHESIS_PREMISES_PROPERTY} AS premises, n.${SYNTHESIS_INFERRED_PROPERTY} AS inferred,`,
  `       n.${SYNTHESIS_CONFIDENCE_PROPERTY} AS confidence, n.${SYNTHESIS_STANDING_PROPERTY} AS standing,`,
  `       n.${BITEMPORAL_PROPERTIES.validUntil} AS closed_at`,
].join('\n');

/** One stored conclusion, however its standing has moved. Used by inspection and the batteries. */
export async function readSynthesis(
  driver: Driver,
  id: string,
): Promise<StoredSynthesis | undefined> {
  const rows = await runRead(driver, READ_SYNTHESIS, { id }, (row) => ({
    id: row.id as string,
    text: (row.text as string | null) ?? '',
    premises: (row.premises as string[] | null) ?? [],
    inferred: row.inferred === true,
    confidence: Number(row.confidence ?? 0),
    standing: ((row.standing as string | null) ?? 'sole') as SynthesisStanding,
    ...(row.closed_at === null || row.closed_at === undefined
      ? {}
      : { closedAt: row.closed_at as Date }),
  }));
  return rows[0];
}
