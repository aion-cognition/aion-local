import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { TEXT_NORM_PROPERTY } from '../../../infrastructure/graph/cognitive-queries.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import { FakeGraph, type FakeNode } from '../../test-support/fake-graph.fixture.js';

/**
 * The supersession stage's own statements on top of the shared `FakeGraph`: this episode's
 * fact-bearing nodes, the label-scoped similarity search for current neighbours, and the
 * bitemporal close. Edge upserts (the `SUPERSEDES` lineage) are already modeled by the base
 * fake. Cosine math is plain JS here; the real query is proven against a live server in
 * `supersession.int.test.ts`.
 */

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  return (value as { toNumber?: () => number }).toNumber?.() ?? 0;
}

export class SupersessionFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes('<-[:EXTRACTED_FROM]-(n)') && cypher.includes('content_vec AS content_vec')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#episodeFactNodes(parameters));
    }
    if (cypher.includes('vector.similarity.cosine')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#contradictionCandidates(cypher, parameters));
    }
    if (cypher.includes(`SET old.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#closeSupersededNode(parameters));
    }
    return super.executeQuery(cypher, parameters);
  }

  #episodeFactNodes(parameters: Record<string, unknown>): Row[] {
    const episodeId = parameters.episodeId as string;
    const labels = (parameters.labels ?? []) as readonly string[];
    return [...this.nodes.values()]
      .filter((node) => this.edges.has(`EXTRACTED_FROM:${node.id}:${episodeId}`))
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined)
      .map((node) => ({ node, label: node.labels.find((label) => labels.includes(label)) }))
      .filter((entry): entry is { node: FakeNode; label: string } => entry.label !== undefined)
      .map((entry) => ({
        id: entry.node.id,
        label: entry.label,
        text: entry.node.properties[MEMORY_PROPERTIES.text],
        content_vec: entry.node.properties[MEMORY_PROPERTIES.contentVector] ?? null,
        text_norm: entry.node.properties[TEXT_NORM_PROPERTY],
      }))
      .sort((left, right) => {
        const byText = String(left.text_norm).localeCompare(String(right.text_norm));
        return byText !== 0 ? byText : String(left.id).localeCompare(String(right.id));
      });
  }

  #contradictionCandidates(cypher: string, parameters: Record<string, unknown>): Row[] {
    const label = /MATCH \(n:(\w+)\)/.exec(cypher)?.[1] ?? '';
    const excluded = new Set((parameters.excludeIds ?? []) as readonly string[]);
    const vector = parameters.vector as number[];
    const threshold = parameters.threshold as number;
    const limit = toNumber(parameters.limit);

    return this.nodesWithLabel(label)
      .filter((node) => !excluded.has(node.id))
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined)
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined)
      .filter((node) => Array.isArray(node.properties[MEMORY_PROPERTIES.contentVector]))
      .map((node) => ({
        id: node.id,
        text: node.properties[MEMORY_PROPERTIES.text],
        score: cosine(vector, node.properties[MEMORY_PROPERTIES.contentVector] as number[]),
      }))
      .filter((row) => row.score >= threshold)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  #closeSupersededNode(parameters: Record<string, unknown>): Row[] {
    const id = parameters.oldId as string;
    const node = this.nodes.get(id);
    if (node === undefined) {
      return [];
    }
    if (node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined) {
      node.properties[BITEMPORAL_PROPERTIES.validUntil] = parameters.now;
    }
    if (node.properties[BITEMPORAL_PROPERTIES.txUntil] === undefined) {
      node.properties[BITEMPORAL_PROPERTIES.txUntil] = parameters.now;
    }
    return [
      {
        id,
        validUntil: node.properties[BITEMPORAL_PROPERTIES.validUntil],
        txUntil: node.properties[BITEMPORAL_PROPERTIES.txUntil],
      },
    ];
  }
}

export type FactNodeSeed = {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly vector?: readonly number[];
  readonly episodeId?: string;
  readonly superseded?: boolean;
};

/** A cognitive fact node as `writeCognitiveNode` leaves it, optionally linked to an episode. */
export function seedFactNode(graph: SupersessionFakeGraph, seed: FactNodeSeed): void {
  graph.seedNode(seed.id, [seed.label, 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: seed.text,
    [TEXT_NORM_PROPERTY]: seed.text.toLowerCase(),
    ...(seed.vector === undefined ? {} : { [MEMORY_PROPERTIES.contentVector]: [...seed.vector] }),
    ...(seed.superseded === true
      ? { [BITEMPORAL_PROPERTIES.validUntil]: new Date('2026-01-01T00:00:00.000Z') }
      : {}),
  });
  if (seed.episodeId !== undefined) {
    graph.seedEdge('EXTRACTED_FROM', seed.id, seed.episodeId);
  }
}

type Counters = {
  readonly nodesCreated: number;
  readonly relationshipsCreated: number;
  readonly propertiesSet: number;
};

const NO_CHANGES: Counters = { nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 };

function toResult(rows: readonly Row[], counters: Counters = NO_CHANGES): unknown {
  return {
    records: rows.map((row) => ({ toObject: () => row })),
    summary: { counters: { updates: () => counters } },
  };
}
