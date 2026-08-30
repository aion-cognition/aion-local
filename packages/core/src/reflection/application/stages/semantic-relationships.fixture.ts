import {
  ENTITY_MENTION_TYPE,
  ENTITY_TYPE_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import {
  ENTITY_NAME_NORM_PROPERTY,
  ENTITY_NAME_PROPERTY,
} from '../../../infrastructure/graph/seed-queries.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import { FakeGraph } from '../../test-support/fake-graph.fixture.js';

/**
 * This stage's own statements on top of the shared `FakeGraph`: the entity-mention read
 * `entities.fixture.ts` already models for its own stage, and the `EXTRACTED_FROM` read this
 * stage adds on top of it. Everything else (node merge, edge merge, episode context) falls
 * through to the shared fake unchanged. Live behaviour is proven in the `.int.test.ts`.
 */

type Counters = {
  readonly nodesCreated: number;
  readonly relationshipsCreated: number;
  readonly propertiesSet: number;
};

const NO_CHANGES: Counters = { nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 };

function toResult(rows: readonly Row[]): unknown {
  return {
    records: rows.map((row) => ({ toObject: () => row })),
    summary: { counters: { updates: () => NO_CHANGES } },
  };
}

export class SemanticRelationshipFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes(`-[:${ENTITY_MENTION_TYPE}]->(n:Entity)`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#episodeEntities(parameters));
    }
    if (cypher.includes('<-[:EXTRACTED_FROM]-(n)')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#episodeCognitiveNodes(parameters));
    }
    return super.executeQuery(cypher, parameters);
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

  #episodeCognitiveNodes(parameters: Record<string, unknown>): Row[] {
    const episodeId = parameters.episodeId as string;
    const labels = (parameters.labels ?? []) as readonly string[];
    return this.edgesOfType('EXTRACTED_FROM')
      .filter((edge) => edge.targetId === episodeId)
      .map((edge) => this.nodes.get(edge.sourceId))
      .filter((node): node is NonNullable<typeof node> => node !== undefined)
      .filter((node) => node.labels.some((label) => labels.includes(label)))
      .map((node) => ({
        id: node.id,
        label: node.labels.find((label) => labels.includes(label)),
        text: node.properties[MEMORY_PROPERTIES.text],
      }))
      .sort((left, right) =>
        `${left.text as string}${left.id}`.localeCompare(`${right.text as string}${right.id}`),
      );
  }
}
