import { ACCESS_COUNT_PROPERTY } from '../../../infrastructure/graph/access-tracking.js';
import { BITEMPORAL_PROPERTIES } from '../../../infrastructure/graph/bitemporal.js';
import {
  ENTITY_MENTION_TYPE,
  ENTITY_NAME_SQUASH_PROPERTY,
  ENTITY_NAME_VECTOR_HASH_PROPERTY,
  ENTITY_TYPE_COUNTS_PROPERTY,
  ENTITY_TYPE_PROPERTY,
} from '../../../infrastructure/graph/entity-queries.js';
import { MEMORY_PROPERTIES } from '../../../infrastructure/graph/episodes.js';
import {
  ENTITY_ALIASES_NORM_PROPERTY,
  ENTITY_ALIASES_PROPERTY,
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
 *
 * The merge chain walk has no model here: a lineage edge is graph shape, and resolving one is
 * exactly the behaviour a fake would get wrong quietly.
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
  readonly id: string;
  readonly properties: Record<string, unknown>;
};

type IdentityUpdate = {
  readonly id: string;
  readonly type: string;
  readonly type_counts: string;
  readonly name_squash: string;
  readonly aliases: string[];
  readonly aliases_norm: string[];
};

type AliasEntry = {
  readonly id: string;
  readonly aliases: string[];
  readonly aliases_norm: string[];
};

type VectorRow = {
  readonly id: string;
  readonly name_vec: number[] | null;
  readonly name_vec_hash: string | null;
  readonly content_vec: number[] | null;
  readonly content_vec_hash: string | null;
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export class EntityFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (cypher.includes(`MERGE (n:Entity { ${ENTITY_NAME_NORM_PROPERTY}:`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#mergeEntities(parameters));
    }
    if (cypher.includes(`SET n.${ENTITY_TYPE_PROPERTY} = update.type`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#writeIdentity(parameters));
    }
    if (cypher.includes(`WHERE is_current OR n.${ENTITY_NAME_NORM_PROPERTY} IN $names`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#nameForms(parameters));
    }
    if (cypher.includes('MATCH (n:Member:Entity)')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#speaker());
    }
    if (cypher.includes(`SET n.${ENTITY_ALIASES_PROPERTY} = coalesce(`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#addAliases(parameters));
    }
    if (cypher.includes(`SET n.${ENTITY_NAME_VECTOR_PROPERTY} = coalesce(entry.name_vec`)) {
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

  #findEntity(nameNorm: string): FakeNode | undefined {
    return this.entities().find((node) => node.properties[ENTITY_NAME_NORM_PROPERTY] === nameNorm);
  }

  /** The identity projection every resolution tier reads, off one node. */
  #identityRow(node: FakeNode): Row {
    return {
      id: node.id,
      name: node.properties[ENTITY_NAME_PROPERTY],
      name_norm: node.properties[ENTITY_NAME_NORM_PROPERTY],
      type: node.properties[ENTITY_TYPE_PROPERTY],
      aliases_norm: strings(node.properties[ENTITY_ALIASES_NORM_PROPERTY]),
      is_structural: node.properties[STRUCTURAL_PROPERTY] === true,
      has_name_vec: node.properties[ENTITY_NAME_VECTOR_PROPERTY] !== undefined,
      name_vec_hash: node.properties[ENTITY_NAME_VECTOR_HASH_PROPERTY] ?? null,
    };
  }

  #current(node: FakeNode): boolean {
    return (
      node.properties[BITEMPORAL_PROPERTIES.validUntil] == null &&
      node.properties[BITEMPORAL_PROPERTIES.forgottenAt] == null
    );
  }

  #mergeEntities(parameters: Record<string, unknown>): Row[] {
    const entities = (parameters.entities ?? []) as readonly MergeRow[];
    const rows: Row[] = [];

    for (const entity of entities) {
      if (this.#findEntity(entity.name_norm) === undefined) {
        this.seedNode(entity.id, ['Entity', 'Memory', 'AionNode'], entity.properties);
      }
      const node = this.#findEntity(entity.name_norm);
      const properties = node?.properties ?? {};
      rows.push({
        name_norm: entity.name_norm,
        proposed_id: entity.id,
        id: node?.id ?? entity.id,
        created: node?.id === entity.id,
        canonical_name_norm: properties[ENTITY_NAME_NORM_PROPERTY],
        type: properties[ENTITY_TYPE_PROPERTY],
        type_counts: properties[ENTITY_TYPE_COUNTS_PROPERTY] ?? null,
        aliases: strings(properties[ENTITY_ALIASES_PROPERTY]),
        is_structural: properties[STRUCTURAL_PROPERTY] === true,
        has_name_vec: properties[ENTITY_NAME_VECTOR_PROPERTY] !== undefined,
        name_vec_hash: properties[ENTITY_NAME_VECTOR_HASH_PROPERTY] ?? null,
        has_content_vec: properties[MEMORY_PROPERTIES.contentVector] !== undefined,
      });
    }

    return rows;
  }

  #writeIdentity(parameters: Record<string, unknown>): Row[] {
    const updates = (parameters.updates ?? []) as readonly IdentityUpdate[];
    const written: Row[] = [];
    for (const update of updates) {
      const node = this.nodes.get(update.id);
      if (node === undefined) {
        continue;
      }
      node.properties[ENTITY_TYPE_PROPERTY] = update.type;
      node.properties[ENTITY_TYPE_COUNTS_PROPERTY] = update.type_counts;
      node.properties[ENTITY_NAME_SQUASH_PROPERTY] = update.name_squash;
      node.properties[ENTITY_ALIASES_PROPERTY] = update.aliases;
      node.properties[ENTITY_ALIASES_NORM_PROPERTY] = update.aliases_norm;
      written.push({ id: update.id });
    }
    return written;
  }

  /** The name branch answers whatever the node's currency; the alias branch is current-only. */
  #nameForms(parameters: Record<string, unknown>): Row[] {
    const names = strings(parameters.names);
    return this.entities()
      .filter((node) => {
        const nameNorm = node.properties[ENTITY_NAME_NORM_PROPERTY] as string | undefined;
        if (nameNorm !== undefined && names.includes(nameNorm)) {
          return true;
        }
        return (
          this.#current(node) &&
          strings(node.properties[ENTITY_ALIASES_NORM_PROPERTY]).some((alias) =>
            names.includes(alias),
          )
        );
      })
      .map((node): Row => ({ ...this.#identityRow(node), is_current: this.#current(node) }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  #speaker(): Row[] {
    const member = this.nodesWithLabel('Member').find((node) => this.#current(node));
    return member === undefined ? [] : [this.#identityRow(member)];
  }

  /** Append-if-absent, the same union the statement runs in Cypher. */
  #addAliases(parameters: Record<string, unknown>): Row[] {
    const entries = (parameters.entries ?? []) as readonly AliasEntry[];
    const written: Row[] = [];
    for (const entry of entries) {
      const node = this.nodes.get(entry.id);
      if (node === undefined) {
        continue;
      }
      const aliases = strings(node.properties[ENTITY_ALIASES_PROPERTY]);
      const aliasKeys = strings(node.properties[ENTITY_ALIASES_NORM_PROPERTY]);
      node.properties[ENTITY_ALIASES_PROPERTY] = [
        ...aliases,
        ...entry.aliases.filter((alias) => !aliases.includes(alias)),
      ];
      node.properties[ENTITY_ALIASES_NORM_PROPERTY] = [
        ...aliasKeys,
        ...entry.aliases_norm.filter((alias) => !aliasKeys.includes(alias)),
      ];
      written.push({ id: entry.id });
    }
    return written;
  }

  /** The name vector is replaced whenever one is handed in; the content vector is write-if-absent. */
  #writeVectors(parameters: Record<string, unknown>): Row[] {
    const entries = (parameters.entries ?? []) as readonly VectorRow[];
    const written: Row[] = [];
    for (const entry of entries) {
      const node = this.nodes.get(entry.id);
      if (node === undefined) {
        continue;
      }
      if (entry.name_vec !== null) {
        node.properties[ENTITY_NAME_VECTOR_PROPERTY] = entry.name_vec;
        node.properties[ENTITY_NAME_VECTOR_HASH_PROPERTY] = entry.name_vec_hash;
      }
      if (
        node.properties[MEMORY_PROPERTIES.contentVector] === undefined &&
        entry.content_vec !== null
      ) {
        node.properties[MEMORY_PROPERTIES.contentVector] = entry.content_vec;
        node.properties[MEMORY_PROPERTIES.contentVectorHash] = entry.content_vec_hash;
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
