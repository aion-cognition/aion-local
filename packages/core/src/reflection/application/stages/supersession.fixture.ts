import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import { TEXT_NORM_PROPERTY } from '../../../infrastructure/graph/cognitive-queries.js';
import { SUPERSEDES_TYPE } from '../../../infrastructure/graph/relationships.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { StructuredRequest } from '../../../infrastructure/providers/types.js';
import { SqliteStore, type SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import {
  listSupersessionProposals,
  type SupersessionProposal,
} from '../../../infrastructure/sqlite/supersession-proposals.js';
import type { StageContext } from '../../domain/stage.js';
import {
  FakeGraph,
  type FakeNode,
  type RecordedStatement,
} from '../../test-support/fake-graph.fixture.js';

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
    if (cypher.includes('$subjectTextNorm CONTAINS')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#subjectIdentityCandidates(parameters));
    }
    if (cypher.includes('vector.similarity.cosine')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#contradictionCandidates(parameters));
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

  /** Current fact-bearing nodes of any label in `$labels`, which is the label expression's row set. */
  #currentFactNodes(parameters: Record<string, unknown>): { node: FakeNode; label: string }[] {
    const labels = (parameters.labels ?? []) as readonly string[];
    const excluded = new Set((parameters.excludeIds ?? []) as readonly string[]);
    return [...this.nodes.values()]
      .filter((node) => !excluded.has(node.id))
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined)
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined)
      .map((node) => ({ node, label: node.labels.find((label) => labels.includes(label)) }))
      .filter((entry): entry is { node: FakeNode; label: string } => entry.label !== undefined);
  }

  #contradictionCandidates(parameters: Record<string, unknown>): Row[] {
    const vector = parameters.vector as number[];
    const threshold = parameters.threshold as number;
    const limit = toNumber(parameters.limit);

    return this.#currentFactNodes(parameters)
      .filter((entry) => Array.isArray(entry.node.properties[MEMORY_PROPERTIES.contentVector]))
      .map((entry) => ({
        id: entry.node.id,
        label: entry.label,
        text: entry.node.properties[MEMORY_PROPERTIES.text],
        score: cosine(vector, entry.node.properties[MEMORY_PROPERTIES.contentVector] as number[]),
        shared_subject: null,
      }))
      .filter((row) => row.score >= threshold)
      .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))
      .slice(0, limit);
  }

  /** The subject leg: entities this episode mentions that the subject claim names, then who else names them. */
  #subjectIdentityCandidates(parameters: Record<string, unknown>): Row[] {
    const episodeId = parameters.episodeId as string;
    const subjectTextNorm = parameters.subjectTextNorm as string;
    const minNameLength = toNumber(parameters.minNameLength);
    const vector = parameters.vector as number[];
    const limit = toNumber(parameters.limit);

    const subjects = this.nodesWithLabel('Entity')
      .filter((node) => this.edges.has(`MENTIONS:${episodeId}:${node.id}`))
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined)
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined)
      .filter((node) => String(node.properties.name_norm ?? '').length >= minNameLength)
      .filter((node) => subjectTextNorm.includes(String(node.properties.name_norm)));
    if (subjects.length === 0) {
      return [];
    }

    const names = subjects.map((node) => String(node.properties.name_norm));
    const subjectIds = new Set(subjects.map((node) => node.id));

    return this.#currentFactNodes(parameters)
      .map((entry) => ({
        entry,
        named: names.find((name) => String(entry.node.properties[TEXT_NORM_PROPERTY]).includes(name)),
      }))
      .filter((row) => row.named !== undefined || this.#sharesEpisodeSubject(row.entry.node, subjectIds))
      .map((row) => ({
        id: row.entry.node.id,
        label: row.entry.label,
        text: row.entry.node.properties[MEMORY_PROPERTIES.text],
        score: Array.isArray(row.entry.node.properties[MEMORY_PROPERTIES.contentVector])
          ? cosine(vector, row.entry.node.properties[MEMORY_PROPERTIES.contentVector] as number[])
          : 0,
        shared_subject: row.named ?? null,
      }))
      .sort((left, right) => right.score - left.score || String(left.id).localeCompare(String(right.id)))
      .slice(0, limit);
  }

  #sharesEpisodeSubject(node: FakeNode, subjectIds: ReadonlySet<string>): boolean {
    return [...this.edges.values()].some(
      (edge) =>
        edge.type === 'EXTRACTED_FROM' &&
        edge.sourceId === node.id &&
        [...this.edges.values()].some(
          (mention) =>
            mention.type === 'MENTIONS' &&
            mention.sourceId === edge.targetId &&
            subjectIds.has(mention.targetId),
        ),
    );
  }

  /** Every bitemporal close this graph was asked for: the spy behind "propose mode never supersedes". */
  closeStatements(): RecordedStatement[] {
    return this.statements.filter((statement) =>
      statement.cypher.includes(`SET old.${BITEMPORAL_PROPERTIES.validUntil} = coalesce(`),
    );
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

export type EntitySeed = {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  /** Every episode whose `MENTIONS` edge points at this entity. */
  readonly mentionedBy: readonly string[];
};

/** A canonical Entity as the entity stage leaves it, with the mention edges the subject leg walks. */
export function seedEntity(graph: SupersessionFakeGraph, seed: EntitySeed): void {
  graph.seedNode(seed.id, ['Entity', 'Memory', 'AionNode'], {
    name: seed.name,
    name_norm: seed.name.toLowerCase(),
    type: seed.type,
  });
  for (const episodeId of seed.mentionedBy) {
    graph.seedEdge('MENTIONS', episodeId, seed.id);
  }
}

export type KeyedVerdict = {
  /** A phrase from one statement of the pair, so a battery does not depend on judgment order. */
  readonly match: string;
  readonly verdict: unknown;
};

/**
 * Graph, store, and stubbed provider for one test, so the stage's own files and its battery
 * share one setup rather than two copies of it. Open it in `beforeEach`, close it in
 * `afterEach`; every field is public because a test bed has no secrets from its tests.
 */
export class SupersessionTestBed {
  readonly sessionId = 'session-1';
  readonly now = new Date('2026-08-28T09:05:00.000Z');
  graph = new SupersessionFakeGraph();
  requests: StructuredRequest[] = [];
  /** Consumed in order by any judgment no keyed verdict matched. */
  responses: unknown[] = [];
  verdicts: KeyedVerdict[] = [];
  #store: SqliteStore | undefined;
  #dataDir = '';

  open(): void {
    this.graph = new SupersessionFakeGraph();
    this.requests = [];
    this.responses = [];
    this.verdicts = [];
    this.#dataDir = mkdtempSync(join(tmpdir(), 'aion-supersession-stage-'));
    this.#store = new SqliteStore({ filePath: join(this.#dataDir, 'aion.sqlite') });
  }

  close(): void {
    this.#store?.close();
    rmSync(this.#dataDir, { recursive: true, force: true });
  }

  get db(): SqliteHandle {
    if (this.#store === undefined) {
      throw new Error('test bed is not open');
    }
    return this.#store.db;
  }

  proposals(): SupersessionProposal[] {
    return listSupersessionProposals(this.db);
  }

  context(episodeId: string): StageContext {
    return {
      driver: this.graph.driver,
      db: this.db,
      provider: {
        embed: async () => [],
        generate: async (request: StructuredRequest) => {
          this.requests.push(request);
          const prompt = promptOf(request);
          const keyed = this.verdicts.find((entry) => prompt.includes(entry.match));
          if (keyed !== undefined) {
            return keyed.verdict;
          }
          const next = this.responses.shift();
          if (next instanceof Error) {
            throw next;
          }
          return next ?? { contradicts: false, confidence: 0 };
        },
      },
      episodeId,
      episode: { id: episodeId, sessionId: this.sessionId, text: 'episode body', turns: [] },
      logger: openLogger({ filePath: join(this.#dataDir, 'aion.jsonl'), level: 'fatal' }),
      now: this.now,
    };
  }

  seedEpisode(id: string): void {
    this.graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
      [MEMORY_PROPERTIES.text]: 'episode body',
      [MEMORY_PROPERTIES.sessionId]: this.sessionId,
    });
  }

  supersedesEdges(): { sourceId: string; targetId: string }[] {
    return this.graph
      .edgesOfType(SUPERSEDES_TYPE)
      .map((edge) => ({ sourceId: edge.sourceId, targetId: edge.targetId }));
  }

  validUntil(id: string): unknown {
    return this.graph.nodes.get(id)?.properties[BITEMPORAL_PROPERTIES.validUntil];
  }

  /** Every prompt the stage sent, flattened, in the order it sent them. */
  prompts(): string[] {
    return this.requests.map(promptOf);
  }
}

function promptOf(request: StructuredRequest): string {
  return request.messages.map((message) => message.content).join('\n');
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
