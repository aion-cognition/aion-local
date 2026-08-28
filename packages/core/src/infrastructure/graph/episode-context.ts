import type { Driver } from 'neo4j-driver';
import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { runRead, type GraphStatement } from './connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { readModeFragment, withCurrency } from './read-modes.js';
import type { Row } from './values.js';

/**
 * Algorithm 4 step 2: the episode and its turns, read once at the top of a reflection run
 * and handed to every stage. Reflection reads the present — a forgotten episode is not
 * enriched — so the default read mode applies, which suppresses `forgotten_at` rows and
 * leaves superseded ones eligible.
 */

export type EpisodeTurnContext = {
  readonly id: string;
  readonly role: string;
  readonly sequence: number;
  readonly text: string;
  readonly occurredAt?: Date;
};

export type EpisodeContext = {
  readonly id: string;
  readonly sessionId: string;
  /** The rendered episode body: summary line, turns, tool executions, observations. */
  readonly text: string;
  readonly summary?: string;
  readonly occurredAt?: Date;
  readonly turns: readonly EpisodeTurnContext[];
};

/**
 * Turns come back in the order they were spoken, so extraction reads a conversation rather
 * than a bag of sentences; `id` breaks a tie no writer should ever produce. `OPTIONAL MATCH`
 * keeps an episode with no turns loadable, which is what a payload of tool executions and
 * observations alone stores.
 */
function loadStatement(episodeId: string): GraphStatement {
  const episode = readModeFragment(withCurrency(), 'e', 'rme');
  const turn = readModeFragment(withCurrency(), 't', 'rmt');
  const cypher = [
    'MATCH (e:Episode { id: $episodeId })',
    `WHERE ${episode.where}`,
    `OPTIONAL MATCH (t:Turn)-[:${CONTAINMENT_TYPE}]->(e)`,
    `WHERE ${turn.where}`,
    `WITH e, t ORDER BY t.${MEMORY_PROPERTIES.sequence}, t.id`,
    // `collect` drops the null an episode with no turns yields, so the comprehension only
    // ever sees real nodes and the empty case needs no special handling.
    'WITH e, [turn IN collect(t) | {',
    '  id: turn.id,',
    `  role: turn.${MEMORY_PROPERTIES.role},`,
    `  sequence: turn.${MEMORY_PROPERTIES.sequence},`,
    `  text: turn.${MEMORY_PROPERTIES.text},`,
    `  occurred_at: turn.${BITEMPORAL_PROPERTIES.occurredAt}`,
    '}] AS turns',
    'RETURN',
    '  e.id AS id,',
    `  e.${MEMORY_PROPERTIES.sessionId} AS session_id,`,
    `  e.${MEMORY_PROPERTIES.text} AS text,`,
    `  e.${MEMORY_PROPERTIES.summary} AS summary,`,
    `  e.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at,`,
    '  turns',
  ].join('\n');

  return {
    cypher,
    parameters: { episodeId, ...episode.parameters, ...turn.parameters },
  };
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  return value instanceof Date ? value : undefined;
}

function readTurn(value: unknown): EpisodeTurnContext | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const row = value as Row;
  if (typeof row.id !== 'string') {
    return undefined;
  }
  const occurredAt = asDate(row.occurred_at);
  return {
    id: row.id,
    role: asText(row.role),
    sequence: typeof row.sequence === 'number' ? row.sequence : 0,
    text: asText(row.text),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

function readEpisodeContext(row: Row): EpisodeContext {
  const turns = Array.isArray(row.turns) ? row.turns : [];
  const summary = asOptionalText(row.summary);
  const occurredAt = asDate(row.occurred_at);
  return {
    id: row.id as string,
    sessionId: asText(row.session_id),
    text: asText(row.text),
    turns: turns.map(readTurn).filter((turn): turn is EpisodeTurnContext => turn !== undefined),
    ...(summary === undefined ? {} : { summary }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
}

/** Undefined when no readable episode carries the id: forgotten, or never written. */
export async function loadEpisodeContext(
  driver: Driver,
  episodeId: string,
): Promise<EpisodeContext | undefined> {
  const statement = loadStatement(episodeId);
  const rows = await runRead(driver, statement.cypher, statement.parameters, readEpisodeContext);
  return rows[0];
}
