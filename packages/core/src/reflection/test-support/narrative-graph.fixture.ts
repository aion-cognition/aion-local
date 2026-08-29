import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
  NARRATIVE_SOURCE_LABELS,
} from '../../infrastructure/graph/narrative-queries.js';
import { coerceGraphValue, type Row } from '../../infrastructure/graph/values.js';
import { FakeGraph, type FakeNode } from './fake-graph.fixture.js';

/**
 * The narrative reads on top of the intake fake, so one unit test can drive a whole session
 * close without a server: the three statements `narrative-queries.ts` issues, plus the
 * supersession close, which the intake path never writes. Everything else — the stamped node
 * write, the edge upserts, the content-vector write — is already modeled by `FakeGraph` and
 * delegates to it. The live behaviour is proven by `narratives.int.test.ts`.
 *
 * Interception comes before the base dispatcher on purpose: the session-episode and
 * idle-session queries both mention `(e:Episode)`, which the base class reads as its
 * content-hash lookup.
 */
function toResult(rows: readonly Row[]): unknown {
  return {
    records: rows.map((row) => ({ toObject: () => row })),
    summary: {
      counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 }) },
    },
  };
}

/** Seeded properties are plain Dates; a query parameter arrives as the driver's DateTime. */
function timeOf(value: unknown): number {
  const coerced = coerceGraphValue(value);
  return coerced instanceof Date ? coerced.getTime() : 0;
}

export class NarrativeFakeGraph extends FakeGraph {
  override async executeQuery(
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> {
    // Before the session-episode branch: the source-node read walks through `(e:Episode)` too.
    if (cypher.includes('[:EXTRACTED_FROM]->(e:Episode)')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#sessionSourceNodes(parameters));
    }
    if (cypher.includes('(:Session { id: $sessionId })') && cypher.includes('(e:Episode)')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#sessionEpisodes(parameters));
    }
    // Before the per-session narrative read, which the stale-revision scan otherwise matches.
    if (cypher.includes(`coalesce(n.${NARRATIVE_PROPERTIES.grounding}, '')`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#staleNarratives(parameters));
    }
    if (cypher.includes(`SET n.${BITEMPORAL_PROPERTIES.forgottenAt} = coalesce`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#forgetNarrative(parameters));
    }
    // The idle sweep matches narratives too, so its own marker is tested first.
    if (cypher.includes('AS last_activity')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#idleSessions(parameters));
    }
    if (cypher.includes('(n:Narrative)')) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#sessionNarratives(parameters));
    }
    if (cypher.includes(`SET old.${BITEMPORAL_PROPERTIES.validUntil}`)) {
      this.statements.push({ cypher, parameters });
      return toResult(this.#closeSuperseded(parameters));
    }
    return super.executeQuery(cypher, parameters);
  }

  /** Sessions an episode reaches through the containment edge, which is what the real MATCH walks. */
  #episodesOf(sessionId: string): FakeNode[] {
    return this.nodesWithLabel('Episode')
      .filter((node) => this.edges.has(`${CONTAINMENT_TYPE}:${node.id}:${sessionId}`))
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined);
  }

  #sessionEpisodes(parameters: Record<string, unknown>): Row[] {
    return this.#episodesOf(parameters.sessionId as string)
      .sort(
        (left, right) =>
          timeOf(left.properties[BITEMPORAL_PROPERTIES.occurredAt]) -
            timeOf(right.properties[BITEMPORAL_PROPERTIES.occurredAt]) ||
          timeOf(left.properties[BITEMPORAL_PROPERTIES.txFrom]) -
            timeOf(right.properties[BITEMPORAL_PROPERTIES.txFrom]) ||
          left.id.localeCompare(right.id),
      )
      .map((node) => ({
        id: node.id,
        text: node.properties[MEMORY_PROPERTIES.text],
        summary: node.properties[MEMORY_PROPERTIES.summary],
        occurred_at: node.properties[BITEMPORAL_PROPERTIES.occurredAt],
        tx_from: node.properties[BITEMPORAL_PROPERTIES.txFrom],
      }));
  }

  /** Claim-bearing nodes extracted from the session's episodes, episode order preserved. */
  #sessionSourceNodes(parameters: Record<string, unknown>): Row[] {
    const rows: Row[] = [];
    for (const episode of this.#sessionEpisodes(parameters)) {
      for (const node of this.nodes.values()) {
        const labelled = node.labels.some((label) =>
          (NARRATIVE_SOURCE_LABELS as readonly string[]).includes(label),
        );
        if (!labelled || !this.edges.has(`EXTRACTED_FROM:${node.id}:${String(episode.id)}`)) {
          continue;
        }
        rows.push({
          id: node.id,
          kind: node.labels.find((label) =>
            (NARRATIVE_SOURCE_LABELS as readonly string[]).includes(label),
          ),
          text: node.properties[MEMORY_PROPERTIES.text],
          episode_id: episode.id,
        });
      }
    }
    return rows;
  }

  /** Standing narratives from an older grounding revision, and what their session can ground. */
  #staleNarratives(parameters: Record<string, unknown>): Row[] {
    const rows: Row[] = [];
    for (const session of this.nodesWithLabel('Session')) {
      for (const narrative of this.#narrativesOf(session.id)) {
        const stale =
          narrative.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined &&
          narrative.properties[NARRATIVE_PROPERTIES.grounding] !== parameters.grounding;
        if (stale) {
          rows.push({
            id: narrative.id,
            session_id: session.id,
            episode_count: this.#episodesOf(session.id).length,
          });
        }
      }
    }
    return rows;
  }

  #forgetNarrative(parameters: Record<string, unknown>): Row[] {
    const node = this.nodes.get(parameters.id as string);
    if (node === undefined) {
      return [];
    }
    node.properties[BITEMPORAL_PROPERTIES.forgottenAt] ??= parameters.now;
    node.properties[BITEMPORAL_PROPERTIES.validUntil] ??= parameters.now;
    node.properties[BITEMPORAL_PROPERTIES.txUntil] ??= parameters.now;
    return [{ id: node.id }];
  }

  #narrativesOf(sessionId: string): FakeNode[] {
    return this.nodesWithLabel('Narrative')
      .filter((node) => this.edges.has(`${DERIVES_FROM_TYPE}:${node.id}:${sessionId}`))
      .filter((node) => node.properties[BITEMPORAL_PROPERTIES.forgottenAt] === undefined);
  }

  #sessionNarratives(parameters: Record<string, unknown>): Row[] {
    return this.#narrativesOf(parameters.sessionId as string)
      .map((node) => ({
        id: node.id,
        version: node.properties[NARRATIVE_PROPERTIES.version],
        coverage_key: node.properties[NARRATIVE_PROPERTIES.coverageKey],
        coverage_count: node.properties[NARRATIVE_PROPERTIES.coverageCount],
        open: node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined,
      }))
      .sort((left, right) => Number(right.version) - Number(left.version));
  }

  /** Quiet since `idleBefore`, and not already covered by an open narrative. */
  #idleSessions(parameters: Record<string, unknown>): Row[] {
    const idleBefore = timeOf(parameters.idleBefore);
    const rows: Row[] = [];

    for (const session of this.nodesWithLabel('Session')) {
      const episodes = this.#episodesOf(session.id);
      if (episodes.length === 0) {
        continue;
      }
      const lastActivity = Math.max(
        ...episodes.map((node) => timeOf(node.properties[BITEMPORAL_PROPERTIES.txFrom])),
      );
      const covered = this.#narrativesOf(session.id)
        .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined)
        .map((node) => Number(node.properties[NARRATIVE_PROPERTIES.coverageCount] ?? 0));
      if (lastActivity > idleBefore || Math.max(0, ...covered) >= episodes.length) {
        continue;
      }
      rows.push({
        session_id: session.id,
        last_activity: new Date(lastActivity),
        episode_count: episodes.length,
      });
    }

    return rows.sort((left, right) => timeOf(left.last_activity) - timeOf(right.last_activity));
  }

  /** `coalesce` on both timelines, so a repeated supersession keeps the first one's stamps. */
  #closeSuperseded(parameters: Record<string, unknown>): Row[] {
    const node = this.nodes.get(parameters.oldId as string);
    if (node === undefined) {
      return [];
    }
    const now = parameters.now;
    node.properties[BITEMPORAL_PROPERTIES.validUntil] ??= now;
    node.properties[BITEMPORAL_PROPERTIES.txUntil] ??= now;
    return [
      {
        id: node.id,
        validUntil: node.properties[BITEMPORAL_PROPERTIES.validUntil],
        txUntil: node.properties[BITEMPORAL_PROPERTIES.txUntil],
      },
    ];
  }
}
