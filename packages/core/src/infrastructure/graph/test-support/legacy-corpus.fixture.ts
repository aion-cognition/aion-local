import type { Driver } from 'neo4j-driver';

import { runWrite } from '../connection.js';
import { upsertEdge } from '../edges.js';
import { CONTAINMENT_TYPE } from '../episodes.js';
import type { RelationshipType } from '../relationships.js';

/**
 * The shapes a pre-records corpus holds: an episode whose only witness for a mention is the edge
 * itself, and an episode the archive never got.
 *
 * Every write here goes through the ordinary edge writer, so the edges carry the same identity
 * property and the same clocks a live writer leaves. A fixture that hand-wrote them would prove
 * the migration can read a fixture rather than that it can read the substrate.
 */

/** An entity the way a legacy graph holds one, plus the edges a source of that era wrote. */
export async function seedLegacyMention(
  driver: Driver,
  input: {
    readonly episodeId: string;
    readonly entityId: string;
    readonly name: string;
    readonly now: Date;
  },
): Promise<void> {
  const iso = input.now.toISOString();
  await runWrite(
    driver,
    {
      cypher: [
        'MERGE (e:AionNode:Entity:Memory {id: $id})',
        'ON CREATE SET e.name = $name, e.name_norm = $nameNorm, e.text = $name,',
        '  e.type = "project", e.occurred_at = datetime($iso), e.valid_from = datetime($iso),',
        '  e.tx_from = datetime($iso)',
      ].join('\n'),
      parameters: {
        id: input.entityId,
        name: input.name,
        nameNorm: input.name.trim().toLowerCase(),
        iso,
      },
    },
    () => undefined,
  );
  await seedLegacyEdge(driver, {
    type: 'MENTIONS',
    fromId: input.episodeId,
    toId: input.entityId,
    now: input.now,
  });
  await seedLegacyEdge(driver, {
    type: CONTAINMENT_TYPE,
    fromId: input.entityId,
    toId: input.episodeId,
    now: input.now,
  });
}

export async function seedLegacyEdge(
  driver: Driver,
  input: {
    readonly type: RelationshipType;
    readonly fromId: string;
    readonly toId: string;
    readonly now: Date;
  },
): Promise<void> {
  await upsertEdge(driver, {
    type: input.type,
    sourceId: input.fromId,
    targetId: input.toId,
    strength: 1,
    confidence: 1,
    signals: ['legacy'],
    provenance: ['legacy_fixture'],
    count: 0,
    now: input.now,
  });
}

/**
 * An episode that exists only in the graph: the archive insert failed historically and nothing
 * else records it. It has no raw record anybody can verify, which is exactly what pins it.
 */
export async function seedGraphOnlyEpisode(
  driver: Driver,
  input: { readonly episodeId: string; readonly sessionId: string; readonly now: Date },
): Promise<void> {
  const iso = input.now.toISOString();
  await runWrite(
    driver,
    {
      cypher: [
        'MERGE (e:AionNode:Episode:Memory {id: $id})',
        'ON CREATE SET e.text = "graph only", e.content_hash = $hash, e.session_id = $sessionId,',
        '  e.occurred_at = datetime($iso), e.valid_from = datetime($iso), e.tx_from = datetime($iso)',
      ].join('\n'),
      parameters: {
        id: input.episodeId,
        hash: `hash-${input.episodeId}`,
        sessionId: input.sessionId,
        iso,
      },
    },
    () => undefined,
  );
}
