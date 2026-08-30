import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import {
  ENTITY_MENTION_TYPE,
  ENTITY_TYPE_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
  ENTITY_NAME_VECTOR_PROPERTY,
  LAST_ACCESSED_PROPERTY,
  STRUCTURAL_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import type {
  Provider,
  StructuredRequest,
  Vector,
} from '../../../infrastructure/providers/types.js';
import { FakeGraph, type FakeNode } from '../../test-support/fake-graph.fixture.js';

/**
 * The entity stage's own statements on top of the shared `FakeGraph`, which already models
 * the id-keyed node merge, the edge merge policy, and the episode read. Anything neither
 * models still throws, so a changed write fails loudly rather than being answered by a fake
 * that does not know it changed. Live behaviour is proven in `entities.int.test.ts`.
 */

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

type MergeRow = {
  readonly name_norm: string;
  readonly type: string;
  readonly id: string;
  readonly properties: Record<string, unknown>;
};

type VectorRow = {
  readonly id: string;
  readonly name_vec: number[] | null;
  readonly content_vec: number[] | null;
};

export class EntityFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes(`MERGE (n:Entity { ${ENTITY_NAME_NORM_PROPERTY}:`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#mergeEntities(parameters));
    }
    if (cypher.includes(`n.${STRUCTURAL_PROPERTY} = true`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#structuralEntities(parameters));
    }
    if (cypher.includes(`SET n.${ENTITY_NAME_VECTOR_PROPERTY} = coalesce(`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#writeVectors(parameters));
    }
    if (cypher.includes(`SET n.${LAST_ACCESSED_PROPERTY} = $now`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#recordSalience(parameters));
    }
    if (cypher.includes(`-[:${ENTITY_MENTION_TYPE}]->`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#episodeEntities(parameters));
    }
    return super.executeQuery(cypher, parameters);
  }

  /** Every Entity node the fake holds, whichever label carries it. */
  entities(): FakeNode[] {
    return this.nodesWithLabel('Entity');
  }

  #findEntity(nameNorm: string, type: string): FakeNode | undefined {
    return this.entities().find(
      (node) =>
        node.properties[ENTITY_NAME_NORM_PROPERTY] === nameNorm &&
        node.properties[ENTITY_TYPE_PROPERTY] === type,
    );
  }

  #mergeEntities(parameters: Record<string, unknown>): Row[] {
    const entities = (parameters.entities ?? []) as readonly MergeRow[];
    const rows: Row[] = [];

    for (const entity of entities) {
      const existing = this.#findEntity(entity.name_norm, entity.type);
      if (existing === undefined) {
        this.seedNode(entity.id, ['Entity', 'Memory', 'AionNode'], entity.properties);
      }
      const node = existing ?? this.#findEntity(entity.name_norm, entity.type);
      const properties = node?.properties ?? {};
      rows.push({
        name_norm: entity.name_norm,
        type: entity.type,
        id: node?.id ?? entity.id,
        created: node?.id === entity.id,
        has_name_vec: properties[ENTITY_NAME_VECTOR_PROPERTY] !== undefined,
        has_content_vec: properties[MEMORY_PROPERTIES.contentVector] !== undefined,
      });
    }

    return rows;
  }

  #structuralEntities(parameters: Record<string, unknown>): Row[] {
    const names = (parameters.names ?? []) as readonly string[];
    return this.entities()
      .filter(
        (node) =>
          node.properties[STRUCTURAL_PROPERTY] === true &&
          names.includes(node.properties[ENTITY_NAME_NORM_PROPERTY] as string),
      )
      .map((node) => ({
        id: node.id,
        name_norm: node.properties[ENTITY_NAME_NORM_PROPERTY],
        type: node.properties[ENTITY_TYPE_PROPERTY],
        has_name_vec: node.properties[ENTITY_NAME_VECTOR_PROPERTY] !== undefined,
      }));
  }

  /** `coalesce` semantics: a vector already on the node wins over the one being written. */
  #writeVectors(parameters: Record<string, unknown>): Row[] {
    const entries = (parameters.entries ?? []) as readonly VectorRow[];
    const written: Row[] = [];
    for (const entry of entries) {
      const node = this.nodes.get(entry.id);
      if (node === undefined) {
        continue;
      }
      if (node.properties[ENTITY_NAME_VECTOR_PROPERTY] === undefined && entry.name_vec !== null) {
        node.properties[ENTITY_NAME_VECTOR_PROPERTY] = entry.name_vec;
      }
      if (
        node.properties[MEMORY_PROPERTIES.contentVector] === undefined &&
        entry.content_vec !== null
      ) {
        node.properties[MEMORY_PROPERTIES.contentVector] = entry.content_vec;
      }
      written.push({ id: entry.id });
    }
    return written;
  }

  #recordSalience(parameters: Record<string, unknown>): Row[] {
    for (const id of (parameters.ids ?? []) as readonly string[]) {
      const node = this.nodes.get(id);
      if (node === undefined) {
        continue;
      }
      node.properties[LAST_ACCESSED_PROPERTY] = parameters.now;
      node.properties[ACCESS_COUNT_PROPERTY] =
        ((node.properties[ACCESS_COUNT_PROPERTY] as number | undefined) ?? 0) + 1;
    }
    return [];
  }

  #episodeEntities(parameters: Record<string, unknown>): Row[] {
    const episodeId = parameters.episodeId as string;
    return this.edgesOfType(ENTITY_MENTION_TYPE)
      .filter((edge) => edge.sourceId === episodeId)
      .map((edge) => this.nodes.get(edge.targetId))
      .filter((node): node is NonNullable<typeof node> => node !== undefined)
      .map((node) => ({
        id: node.id,
        name: node.properties[ENTITY_NAME_PROPERTY],
        name_norm: node.properties[ENTITY_NAME_NORM_PROPERTY],
        type: node.properties[ENTITY_TYPE_PROPERTY],
      }))
      .sort((left, right) =>
        `${left.name_norm as string}${left.id}`.localeCompare(
          `${right.name_norm as string}${right.id}`,
        ),
      );
  }
}

export type FakeProvider = Provider & {
  readonly generateCalls: StructuredRequest[];
  readonly embedCalls: string[][];
};

export type FakeProviderScript = {
  /** One entry per `generate` call, in order. A thrown value rejects that call. */
  readonly generate: readonly unknown[];
  /** Rejects every `embed` call, which is how a deferred-vector run is driven. */
  readonly embedFails?: boolean;
};

/** Deterministic stand-in for the model: the unit tests measure the stage, never its answers. */
export function fakeProvider(script: FakeProviderScript): FakeProvider {
  const generateCalls: StructuredRequest[] = [];
  const embedCalls: string[][] = [];

  return {
    generateCalls,
    embedCalls,
    embed: async (texts: readonly string[]): Promise<Vector[]> => {
      embedCalls.push([...texts]);
      if (script.embedFails === true) {
        throw new Error('embed unavailable');
      }
      return texts.map((text, index) => [text.length, index, 1]);
    },
    generate: async (request: StructuredRequest): Promise<unknown> => {
      const answer = script.generate[generateCalls.length];
      generateCalls.push(request);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
  };
}
