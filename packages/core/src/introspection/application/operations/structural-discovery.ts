import { CO_OCCURS_TYPE } from '../../../infrastructure/graph/association-queries.js';
import { upsertEdge } from '../../../infrastructure/graph/edges.js';
import {
  readEntityPairSignals,
  type EntityPairSignals,
} from '../../../infrastructure/graph/entity-signal-queries.js';
import {
  countProjectableEntities,
  findLowDegreeEntities,
  nominateVectorNeighbors,
  readEntityNameForms,
  type VectorNomination,
} from '../../../infrastructure/graph/structural-discovery-queries.js';
import { bucketStamp, type OperationBucket } from '../../domain/buckets.js';
import {
  CRITICAL_MIN_POPULATION,
  HEALTH_COLLECTORS,
  type HealthSnapshot,
} from '../../domain/health.js';
import type {
  IntrospectionOperation,
  OperationContext,
  OperationOutcome,
} from '../../domain/operation.js';
import { discoveryRationale, secondNomination } from '../../domain/structural-discovery.js';

/**
 * Structural edge discovery: two identities that arrived weeks apart, were never recalled
 * together, and therefore never got an edge between them, joined when something other than
 * their embeddings says they belong together.
 *
 * Nominate, then second. A nearest-neighbour cosine finds the pair, because on a graph where
 * neither side has been co-activated nothing else can. It then decides nothing: the pair
 * writes an edge only when the store itself stands behind it, and a pair carrying a cosine
 * and no graph evidence is dropped and counted rather than written weakly.
 *
 * The edge is `CO_OCCURS` rather than `SIMILAR`. Both are association types the read path
 * traverses and the prune sweep may close, but `SIMILAR` is the semantic stage's model output:
 * activation halves its weight for being model-inferred and scales it again by confidence,
 * which is a discount for a provenance this edge does not have. `CO_OCCURS` is the observed
 * tier, and every second behind this write is an observation of the store rather than a
 * proposition from a model.
 *
 * Acting from day one, gated by its own kill switch: off leaves every under-connected identity
 * exactly as it is.
 */

export const STRUCTURAL_DISCOVERY_OPERATION = 'structural_discovery';

const STRUCTURAL_DISCOVERY_BUCKET: OperationBucket = 'day';

/**
 * Written weak, for the reason the orphan relink is: this states that two identities belong in
 * each other's neighbourhood, which is less than a real association arriving later will say.
 * The merge policy takes the stronger of the two, so the later write outranks this one.
 */
const DISCOVERY_STRENGTH = 0.2;
const DISCOVERY_CONFIDENCE = 0.4;

const DISCOVERY_SIGNAL = 'structural_discovery';
const DISCOVERY_PROVENANCE = 'introspection';

/**
 * There is no gauge for how many identities the graph has left under-connected, so this stands
 * on the one reading that moves with disconnection (the share of memories carrying no
 * association at all) over a standing floor, the way community refresh reaches its threshold on
 * waiting time. The floor is what stops a graph whose orphans have all been relinked from
 * reading as a graph with nothing left to join.
 */
export const STRUCTURAL_DISCOVERY_RELEVANCE = 0.15;

export function structuralDiscoveryRelevance(health: HealthSnapshot): number {
  if (health.degraded.includes(HEALTH_COLLECTORS.graph)) {
    return 0;
  }
  // Under the population floor the critical rules use, an under-connected entity is a new
  // entity, and joining it to its nearest neighbour describes the substrate's youth.
  if (health.graph.nodes < CRITICAL_MIN_POPULATION) {
    return 0;
  }
  return Math.min(1, STRUCTURAL_DISCOVERY_RELEVANCE + health.graph.orphanShare);
}

function noop(detail: string, itemsProcessed = 0): OperationOutcome {
  return { status: 'noop', itemsProcessed, itemsAffected: 0, detail };
}

function pairKey(leftId: string, rightId: string): string {
  return `${leftId} ${rightId}`;
}

type Evidence = {
  readonly signalsByPair: ReadonlyMap<string, EntityPairSignals>;
  readonly formsById: ReadonlyMap<string, readonly string[]>;
};

async function gatherEvidence(
  ctx: OperationContext,
  nominations: readonly VectorNomination[],
): Promise<Evidence> {
  const signals = await readEntityPairSignals(ctx.driver, nominations);
  const forms = await readEntityNameForms(
    ctx.driver,
    nominations.flatMap((pair) => [pair.leftId, pair.rightId]),
  );
  return {
    signalsByPair: new Map(signals.map((row) => [pairKey(row.leftId, row.rightId), row])),
    formsById: new Map(forms.map((row) => [row.id, row.forms])),
  };
}

type DiscoveryTally = {
  readonly written: number;
  readonly dropped: number;
};

async function writeDiscoveries(
  ctx: OperationContext,
  nominations: readonly VectorNomination[],
  evidence: Evidence,
): Promise<DiscoveryTally> {
  let written = 0;
  let dropped = 0;
  for (const pair of nominations) {
    if (ctx.signal.aborted) {
      break;
    }
    const signals = evidence.signalsByPair.get(pairKey(pair.leftId, pair.rightId));
    const seconds = secondNomination({
      ...(signals === undefined ? {} : { signals }),
      leftForms: evidence.formsById.get(pair.leftId) ?? [],
      rightForms: evidence.formsById.get(pair.rightId) ?? [],
    });
    if (seconds.length === 0) {
      dropped += 1;
      continue;
    }
    await upsertEdge(ctx.driver, {
      type: CO_OCCURS_TYPE,
      sourceId: pair.leftId,
      targetId: pair.rightId,
      strength: DISCOVERY_STRENGTH,
      confidence: DISCOVERY_CONFIDENCE,
      signals: [DISCOVERY_SIGNAL, ...seconds],
      provenance: [DISCOVERY_PROVENANCE],
      rationale: discoveryRationale(seconds),
      // A discovery is a claim about the pair, not an observation of it, so a re-run adds
      // nothing to the count the co-occurrence writer accumulates.
      count: 0,
      now: ctx.now,
    });
    written += 1;
  }
  return { written, dropped };
}

async function runStructuralDiscovery(ctx: OperationContext): Promise<OperationOutcome> {
  if (!ctx.config.maintenance.structuralDiscovery) {
    return noop(
      'structural edge discovery disabled by AION_MAINTENANCE_STRUCTURAL_DISCOVERY; no pair examined',
    );
  }

  const projectable = await countProjectableEntities(ctx.driver);
  const cap = ctx.config.maintenance.communityNodeLimit;
  if (projectable > cap) {
    return noop(`substrate over the ${String(cap)}-node projection cap`, projectable);
  }

  const seeds = await findLowDegreeEntities(ctx.driver, {
    degreeCeiling: ctx.config.maintenance.structuralDiscoveryDegreeCeiling,
    limit: ctx.config.maintenance.structuralDiscoverySeedBatch,
  });
  if (seeds.length === 0) {
    return noop('every embedded identity already carries associations');
  }

  const nomination = await nominateVectorNeighbors(ctx.driver, {
    seedIds: seeds.map((seed) => seed.id),
    cosineFloor: ctx.config.reflection.associationSemanticThreshold,
    // The knob is the pair ceiling, so the query carries it: read after the fact it would be
    // clamped by the query's own default and a raised setting would report nothing.
    limit: ctx.config.maintenance.structuralDiscoveryBatch,
    logger: ctx.logger,
  });
  if (nomination.status === 'unavailable') {
    return noop('graph data science procedures are not available on this server');
  }

  const stamp = bucketStamp(STRUCTURAL_DISCOVERY_BUCKET, ctx.now);
  const { nominations } = nomination;
  if (nominations.length === 0) {
    return noop(`no unconnected neighbour above the nomination floor in bucket ${stamp}`, 0);
  }

  const tally = await writeDiscoveries(ctx, nominations, await gatherEvidence(ctx, nominations));
  return {
    status: tally.written === 0 ? 'noop' : 'applied',
    itemsProcessed: nominations.length,
    itemsAffected: tally.written,
    detail:
      `bucket ${stamp}: wrote ${String(tally.written)} association edge(s) over ` +
      `${String(nominations.length)} nomination(s) from ${String(seeds.length)} ` +
      `under-connected ${seeds.length === 1 ? 'identity' : 'identities'}; ` +
      `dropped ${String(tally.dropped)} vector-only pair(s)`,
  };
}

export function structuralDiscoveryOperation(): IntrospectionOperation {
  return {
    name: STRUCTURAL_DISCOVERY_OPERATION,
    bucket: STRUCTURAL_DISCOVERY_BUCKET,
    relevance: structuralDiscoveryRelevance,
    run: runStructuralDiscovery,
  };
}
