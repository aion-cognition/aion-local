import type { GraphStatement, GraphTransaction } from './connection.js';
import {
  readSessionEpisode,
  sessionEpisodesStatement,
  sessionSourceNodesStatement,
  type SessionEpisode,
  type SessionSourceNode,
} from './narrative-queries.js';
import { fromGraphDateTime, toGraphInteger } from './values.js';

export const LEGACY_NARRATIVE_LIMITS = {
  episodes: 2048,
  units: 2 * 1024 * 1024,
  closingEdges: 4096,
} as const;

async function inputSize(
  tx: GraphTransaction,
  statement: GraphStatement,
  includeSummary: boolean,
): Promise<{ count: number; units: number }> {
  const query = `CALL { ${statement.cypher} } RETURN count(*) AS count,
    sum(size(coalesce(text, '')) + size(id)${includeSummary ? " + size(coalesce(summary, ''))" : ''}) AS units`;
  const [row] = await tx.run(query, statement.parameters, (result) => ({
    count: Number(result.count),
    units: Number(result.units),
  }));
  if (row === undefined) {
    throw new Error('legacy input query returned no size');
  }
  return row;
}

/** Reuses the legacy read definitions while bounding what crosses the guarded transaction. */
export async function readLegacyNarrativeInputs(
  tx: GraphTransaction,
  sessionId: string,
  at: Date,
  includeExtracted: boolean,
): Promise<
  | {
      readonly episodes: readonly SessionEpisode[];
      readonly extracted: readonly SessionSourceNode[];
    }
  | undefined
> {
  const episodes = sessionEpisodesStatement(sessionId, at);
  const episodeSize = await inputSize(tx, episodes, true);
  if (
    episodeSize.count > LEGACY_NARRATIVE_LIMITS.episodes ||
    episodeSize.units > LEGACY_NARRATIVE_LIMITS.units
  ) {
    return undefined;
  }
  const nodes = sessionSourceNodesStatement(sessionId, at);
  if (
    includeExtracted &&
    (await inputSize(tx, nodes, false)).units + episodeSize.units > LEGACY_NARRATIVE_LIMITS.units
  ) {
    return undefined;
  }
  const source = await tx.run(episodes.cypher, episodes.parameters, readSessionEpisode);
  const extracted = includeExtracted
    ? await tx.run(nodes.cypher, nodes.parameters, (row) => ({
        id: String(row.id),
        kind: typeof row.kind === 'string' ? row.kind.toLowerCase() : 'note',
        text: typeof row.text === 'string' ? row.text : '',
        episodeId: String(row.episode_id),
      }))
    : [];
  return { episodes: source, extracted };
}

export type LegacyCoverageEdge = {
  readonly sourceId: string;
  readonly narrativeId: string;
  readonly relationId: string;
  readonly sourceIsEpisode: boolean;
  readonly clocks: Readonly<Record<string, string>>;
};

/** The same population the closure updates, preserving its original relationship identities and clocks. */
export function readLegacyCoverageEdges(
  tx: GraphTransaction,
  narrativeIds: readonly string[],
): Promise<readonly LegacyCoverageEdge[]> {
  return tx.run(
    `MATCH (s)-[r:SUMMARIZED_BY]->(n:Narrative) WHERE n.id IN $ids AND r.valid_until IS NULL
    RETURN s.id AS source_id, n.id AS narrative_id, coalesce(r.id, elementId(r)) AS relation_id,
      'Episode' IN labels(s) AS episode, r.created_at AS tx_from, r.valid_from AS valid_from, r.tx_until AS tx_until
    LIMIT $limit`,
    { ids: [...narrativeIds], limit: toGraphInteger(LEGACY_NARRATIVE_LIMITS.closingEdges + 1) },
    (row) => {
      const clocks: Record<string, string> = {};
      for (const name of ['tx_from', 'valid_from', 'tx_until']) {
        const at = fromGraphDateTime(row[name]);
        if (at !== undefined) {
          clocks[name] = at.toISOString();
        }
      }
      return {
        sourceId: String(row.source_id),
        narrativeId: String(row.narrative_id),
        relationId: String(row.relation_id),
        sourceIsEpisode: row.episode === true,
        clocks,
      };
    },
  );
}
