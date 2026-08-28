import type { Driver } from 'neo4j-driver';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { LOCK_PROPERTY } from '../../infrastructure/graph/locks.js';
import type { Row } from '../../infrastructure/graph/values.js';

/**
 * An in-memory stand-in for the statements intake and the session manager issue, so unit
 * tests can assert what reaches the graph without a server. It recognises the exact query
 * shapes those two paths build and throws on anything else: when a write path changes, the
 * fake fails loudly rather than answering a query it does not actually model. The live
 * behaviour is proven by `intake.int.test.ts` against a real Neo4j.
 */
export type FakeNode = {
  readonly id: string;
  readonly labels: readonly string[];
  readonly properties: Record<string, unknown>;
};

export type FakeEdge = {
  id: string;
  readonly type: string;
  readonly sourceId: string;
  readonly targetId: string;
  strength: number;
  confidence: number;
  signals: string[];
  provenance: string[];
  count: number;
  createdAt: unknown;
  updatedAt: unknown;
};

export type RecordedStatement = {
  readonly cypher: string;
  readonly parameters: Record<string, unknown>;
};

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

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

export class FakeGraph {
  readonly nodes = new Map<string, FakeNode>();
  readonly edges = new Map<string, FakeEdge>();
  readonly statements: RecordedStatement[] = [];
  /** Node ids a caller took a write lock on, in order. */
  readonly locked: string[] = [];

  /** The fake answers `executeQuery` and `session`, which is the whole surface the adapter's helpers use. */
  get driver(): Driver {
    return this as unknown as Driver;
  }

  /**
   * Transactions run their statements through the same dispatcher and always commit: the
   * fake models what reaches the graph, not isolation. Atomicity and locking are proven
   * against a real server in the integration suites.
   */
  session(): unknown {
    const run = async (cypher: string, parameters: Record<string, unknown> = {}): Promise<unknown> =>
      this.executeQuery(cypher, parameters);
    return {
      executeWrite: async (work: (tx: { run: typeof run }) => Promise<unknown>): Promise<unknown> =>
        work({ run }),
      close: async (): Promise<void> => {},
    };
  }

  seedNode(id: string, labels: readonly string[], properties: Record<string, unknown> = {}): void {
    this.nodes.set(id, { id, labels, properties: { ...properties, id } });
  }

  nodesWithLabel(label: string): FakeNode[] {
    return [...this.nodes.values()].filter((node) => node.labels.includes(label));
  }

  edgesOfType(type: string): FakeEdge[] {
    return [...this.edges.values()].filter((edge) => edge.type === type);
  }

  /** Every parameter the fake was ever asked to write, for "the raw secret never left" assertions. */
  writtenText(): string {
    return JSON.stringify(this.statements);
  }

  async executeQuery(cypher: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
    this.statements.push({ cypher, parameters });

    const nodeMerge = /MERGE \(n:(\w+) \{ id: \$id \}\)/.exec(cypher);
    if (nodeMerge !== null) {
      return this.#mergeNode(nodeMerge[1] as string, cypher, parameters);
    }

    const edgeMerge = /MERGE \(a\)-\[r:(\w+)\]->\(b\)/.exec(cypher);
    if (edgeMerge !== null) {
      return this.#mergeEdge(edgeMerge[1] as string, parameters);
    }

    if (cypher.includes(`SET n.${LOCK_PROPERTY}`)) {
      return this.#lockNode(parameters);
    }

    if (cypher.includes(`SET n.${MEMORY_PROPERTIES.contentVector} = entry.vector`)) {
      return toResult(this.#writeContentVectors(parameters));
    }
    if (cypher.includes(`n.${MEMORY_PROPERTIES.contentVector} IS NULL`)) {
      return toResult(this.#pendingVectorNodes(parameters));
    }

    if (cypher.includes('(e:Episode)')) {
      return toResult(this.#findEpisodeByContentHash(parameters));
    }
    if (cypher.includes('(prior:Session)')) {
      return toResult(this.#followsTarget(parameters));
    }
    if (cypher.includes('(:Member { id: $memberId })')) {
      return toResult(this.#priorSession(parameters));
    }

    throw new Error(`FakeGraph has no model for this statement:\n${cypher}`);
  }

  #mergeNode(label: string, cypher: string, parameters: Record<string, unknown>): unknown {
    const id = parameters.id as string;
    const existing = this.nodes.get(id);
    if (existing !== undefined) {
      const merged = { ...existing.properties, ...(parameters.mergeProperties as Row | undefined) };
      this.nodes.set(id, { ...existing, properties: merged });
      return toResult([{ id, labels: existing.labels }]);
    }

    const companions = /SET n:([\w:]+)/.exec(cypher);
    const labels = [label, ...(companions === null ? [] : (companions[1] as string).split(':'))];
    const properties = {
      ...(parameters.properties as Row),
      ...(parameters.mergeProperties as Row | undefined),
    };
    this.nodes.set(id, { id, labels, properties });

    return toResult([{ id, labels }], {
      nodesCreated: 1,
      relationshipsCreated: 0,
      propertiesSet: Object.keys(properties).length,
    });
  }

  #mergeEdge(type: string, parameters: Record<string, unknown>): unknown {
    const sourceId = parameters.sourceId as string;
    const targetId = parameters.targetId as string;
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) {
      return toResult([]);
    }

    const key = `${type}:${sourceId}:${targetId}`;
    const existing = this.edges.get(key);
    const count = parameters.count as number;

    if (existing === undefined) {
      this.edges.set(key, {
        id: parameters.id as string,
        type,
        sourceId,
        targetId,
        strength: parameters.strength as number,
        confidence: parameters.confidence as number,
        signals: asStrings(parameters.signals),
        provenance: asStrings(parameters.provenance),
        count,
        createdAt: parameters.now,
        updatedAt: parameters.now,
      });
    } else {
      existing.strength = Math.max(existing.strength, parameters.strength as number);
      existing.confidence = Math.max(existing.confidence, parameters.confidence as number);
      existing.signals = [...new Set([...existing.signals, ...asStrings(parameters.signals)])];
      existing.provenance = [...new Set([...existing.provenance, ...asStrings(parameters.provenance)])];
      existing.count += count;
      existing.updatedAt = parameters.now;
    }

    const edge = this.edges.get(key) as FakeEdge;
    return toResult([{ ...edge, rationale: null }]);
  }

  /** Records that the lock was taken and on which node; the fake serializes nothing. */
  #lockNode(parameters: Record<string, unknown>): unknown {
    const id = parameters.id as string;
    const node = this.nodes.get(id);
    if (node !== undefined) {
      this.locked.push(id);
    }
    return toResult([]);
  }

  #writeContentVectors(parameters: Record<string, unknown>): Row[] {
    const entries = (parameters.entries ?? []) as Array<{ id: string; vector: number[] }>;
    const written: Row[] = [];
    for (const entry of entries) {
      const node = this.nodes.get(entry.id);
      if (node !== undefined) {
        node.properties[MEMORY_PROPERTIES.contentVector] = entry.vector;
        written.push({ id: entry.id });
      }
    }
    return written;
  }

  /** The pending-vector marker, modeled exactly as the real query reads it: `:Memory`, text, no vector. */
  #pendingVectorNodes(parameters: Record<string, unknown>): Row[] {
    const raw = parameters.limit as { toNumber?: () => number } | number;
    const limit = typeof raw === 'number' ? raw : (raw.toNumber?.() ?? 0);
    return this.nodesWithLabel('Memory')
      .filter(
        (node) =>
          node.properties[MEMORY_PROPERTIES.contentVector] === undefined &&
          typeof node.properties[MEMORY_PROPERTIES.text] === 'string',
      )
      .slice(0, limit)
      .map((node) => ({ id: node.id, text: node.properties[MEMORY_PROPERTIES.text] }));
  }

  #findEpisodeByContentHash(parameters: Record<string, unknown>): Row[] {
    const sessionId = parameters.sessionId as string;
    const contentHash = parameters.contentHash as string;

    for (const node of this.nodes.values()) {
      const matchesHash =
        node.labels.includes('Episode') && node.properties.content_hash === contentHash;
      const inSession = this.edges.has(`PARTICIPATES_IN:${node.id}:${sessionId}`);
      if (matchesHash && inSession) {
        return [{ id: node.id }];
      }
    }
    return [];
  }

  #followsTarget(parameters: Record<string, unknown>): Row[] {
    const sessionId = parameters.sessionId as string;
    for (const edge of this.edges.values()) {
      if (edge.type === 'FOLLOWS' && edge.sourceId === sessionId) {
        return [{ id: edge.targetId }];
      }
    }
    return [];
  }

  /** The chain's tail: the member's session that no other session FOLLOWS. */
  #priorSession(parameters: Record<string, unknown>): Row[] {
    const sessionId = parameters.sessionId as string;
    const followed = new Set(
      [...this.edges.values()].filter((edge) => edge.type === 'FOLLOWS').map((edge) => edge.targetId),
    );
    const tail = this.nodesWithLabel('Session').find(
      (node) => node.id !== sessionId && !followed.has(node.id),
    );
    return tail === undefined ? [] : [{ id: tail.id }];
  }
}
