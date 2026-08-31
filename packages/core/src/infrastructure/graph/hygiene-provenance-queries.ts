import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead } from './connection.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import type { Row } from './values.js';

/**
 * The episode-clock signals `proposal_hygiene` classifies a proposal on, batched by id
 * because a hygiene run reads a page of proposals per tick, not one. Missing from the map
 * means unreadable: forgotten, or the id names no episode at all. The classifier treats
 * either the same way, so this read need not tell them apart.
 */
export type HygieneEpisodeProvenance = {
  readonly occurredAt: Date;
  readonly turnCount: number;
  readonly toolExecutionCount: number;
  readonly originChannel?: string;
  readonly originEvent?: string;
};

function statement(ids: readonly string[]): {
  cypher: string;
  parameters: Record<string, unknown>;
} {
  const fragment = readModeFragment(withCurrency(), 'e');
  const cypher = [
    'UNWIND $ids AS wantedId',
    'MATCH (e:Episode { id: wantedId })',
    `WHERE ${fragment.where}`,
    'RETURN e.id AS id,',
    `       e.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at,`,
    `       e.${MEMORY_PROPERTIES.turnCount} AS turn_count,`,
    `       e.${MEMORY_PROPERTIES.toolExecutionCount} AS tool_execution_count,`,
    `       e.${MEMORY_PROPERTIES.originChannel} AS origin_channel,`,
    `       e.${MEMORY_PROPERTIES.originEvent} AS origin_event`,
  ].join('\n');
  return { cypher, parameters: { ids: [...new Set(ids)], ...fragment.parameters } };
}

function mapRow(row: Row): { id: string; provenance: HygieneEpisodeProvenance } | undefined {
  const occurredAt = row.occurred_at;
  if (!(occurredAt instanceof Date)) {
    return undefined;
  }
  const originChannel = row.origin_channel;
  const originEvent = row.origin_event;
  return {
    id: row.id as string,
    provenance: {
      occurredAt,
      turnCount: typeof row.turn_count === 'number' ? row.turn_count : 0,
      toolExecutionCount:
        typeof row.tool_execution_count === 'number' ? row.tool_execution_count : 0,
      ...(typeof originChannel === 'string' ? { originChannel } : {}),
      ...(typeof originEvent === 'string' ? { originEvent } : {}),
    },
  };
}

export async function fetchHygieneEpisodeProvenance(
  driver: Driver,
  ids: readonly string[],
): Promise<ReadonlyMap<string, HygieneEpisodeProvenance>> {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await runRead(driver, statement(ids), mapRow);
  return new Map(
    rows
      .filter(
        (row): row is { id: string; provenance: HygieneEpisodeProvenance } => row !== undefined,
      )
      .map((row) => [row.id, row.provenance]),
  );
}
