import neo4j, { type Driver } from 'neo4j-driver';

import { TEXT_NORM_PROPERTY, type CognitiveNodeLabel } from './cognitive-queries.js';
import { runRead, type GraphStatement } from './connection.js';
import { ENTITY_MENTION_TYPE } from './entity-queries.js';
import { MEMORY_PROPERTIES } from './episodes.js';
import { BASE_NODE_LABEL, type NodeLabel } from './labels.js';
import { readModeFragment, type ReadMode } from './read-modes.js';
import { ENTITY_NAME_NORM_PROPERTY } from './seed-queries.js';
import { MIN_SUBJECT_NAME_LENGTH } from './supersession-queries.js';
import type { Row } from './values.js';

/**
 * The current claim that stands beside a raw turn.
 *
 * A Turn is captured text. Nothing distils it into a claim, and supersession judges extracted
 * cognitive nodes, so a belief a person stated in a turn is never a candidate for closing and
 * answers as current for as long as the substrate holds it. That is harmless while the
 * correction is co-retrieved, which a direct question does. It is not harmless when resonance
 * surfaces the turn alone, because the pack then carries a stated belief with nothing around
 * it. This read finds what the substrate currently claims about the same subject, so the pack
 * can print it beside the turn.
 *
 * No contradiction is decided here and none is asserted downstream. Judging a reversal is a
 * model's job and it already has one, in reflection. This is retrieval: it puts the current
 * claim in front of the reading agent, which arbitrates correctly whenever both statements
 * are in the pack.
 */

/**
 * The claim types a stated belief can be answered by. An Event records that something
 * happened and a Goal or a Plan states an intention, so neither answers "what is true now"
 * in the way a turn's assertion asks to be answered.
 */
const CLAIM_LABELS = [
  'Insight',
  'Decision',
  'Concept',
] as const satisfies readonly CognitiveNodeLabel[];

/** One label scan per label rather than a full store scan, the same as the supersession reads. */
const CLAIM_LABEL_EXPRESSION = CLAIM_LABELS.join('|');

/** Intake is the only writer of Turn nodes, so this label is the whole test for captured text. */
const TURN_LABEL: NodeLabel = 'Turn';

/** `LIMIT` is Cypher INTEGER; a plain JS number arrives as FLOAT and is rejected. */
function toGraphInteger(value: number): unknown {
  return neo4j.int(Math.trunc(value));
}

export type RelatedClaimRequest = {
  /** The raw turn's node id. */
  readonly id: string;
  /**
   * The turn's text, folded the way entity names are folded, so a name matches inside it. The
   * caller supplies it because a Turn stores no normalization of its own, exactly as the
   * supersession candidate read takes the judged claim's fold as a parameter.
   */
  readonly textNorm: string;
};

export type RelatedClaimRow = {
  readonly turnId: string;
  readonly id: string;
  readonly text: string;
  /** True cosine between the claim's content vector and the turn's own. */
  readonly relatedness: number;
};

export type RelatedClaimInput = {
  /** The raw turns to annotate. Bounded by the resonant bucket, so typically none to three. */
  readonly turns: readonly RelatedClaimRequest[];
  /** Cosine a claim has to reach before it is worth printing beside the turn. */
  readonly floor: number;
  readonly mode: ReadMode;
};

/**
 * Subject identity, the notion the supersession stage already uses: the subjects are entities
 * whose stored name appears inside the turn's own fold, and a claim is in the family when it
 * names one of those subjects or hangs off an episode that mentions one. The names are the
 * model's own and the match is a substring test between two stored normalizations, so no
 * keyword machinery enters the recall path.
 *
 * The subjects come off the turn rather than off its episode. An episode holds several turns
 * about several things, and the one that matters here is the turn: the belief that prompted
 * this read was stated in the fourth turn of an episode whose extracted entities were all
 * about the first two.
 *
 * Claims extracted from the turn's own episode are excluded. What that episode produced
 * restates what the turn already says, and the annotation exists to carry what the substrate
 * learned somewhere else.
 *
 * One row per turn: the claims are ranked by cosine against the turn's own content vector and
 * the best one is kept, because a pack has room for the current claim and not for a reading
 * list.
 */
function relatedClaimsStatement(mode: ReadMode): GraphStatement {
  const turn = readModeFragment(mode, 't', 'rmt');
  const entity = readModeFragment(mode, 'e', 'rme');
  const claim = readModeFragment(mode, 'n', 'rmn');
  const cypher = [
    'UNWIND $turns AS wanted',
    `MATCH (t:${BASE_NODE_LABEL} { id: wanted.id })`,
    `WHERE $turnLabel IN labels(t)`,
    `  AND t.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
    `  AND ${turn.where}`,
    'MATCH (e:Entity)',
    `WHERE ${entity.where}`,
    `  AND size(e.${ENTITY_NAME_NORM_PROPERTY}) >= $minNameLength`,
    `  AND wanted.textNorm CONTAINS e.${ENTITY_NAME_NORM_PROPERTY}`,
    'WITH wanted, t, collect(DISTINCT e.id) AS subjectIds,',
    `     collect(DISTINCT e.${ENTITY_NAME_NORM_PROPERTY}) AS names`,
    `MATCH (n:${CLAIM_LABEL_EXPRESSION})`,
    `WHERE ${claim.where}`,
    `  AND (${claim.currency}) = 'current'`,
    `  AND n.${MEMORY_PROPERTIES.contentVector} IS NOT NULL`,
    `  AND size(n.${MEMORY_PROPERTIES.contentVector}) = size(t.${MEMORY_PROPERTIES.contentVector})`,
    '  AND NOT EXISTS {',
    '    MATCH (n)-[:EXTRACTED_FROM]->(own:Episode)',
    `    WHERE own.id = t.${MEMORY_PROPERTIES.sourceEpisodeId}`,
    '  }',
    `  AND (head([name IN names WHERE n.${TEXT_NORM_PROPERTY} CONTAINS name]) IS NOT NULL`,
    '       OR EXISTS {',
    `         MATCH (n)-[:EXTRACTED_FROM]->(:Episode)-[:${ENTITY_MENTION_TYPE}]->(shared:Entity)`,
    '         WHERE shared.id IN subjectIds',
    '       })',
    'WITH wanted, n, 2.0 * vector.similarity.cosine(',
    `       n.${MEMORY_PROPERTIES.contentVector}, t.${MEMORY_PROPERTIES.contentVector}`,
    '     ) - 1.0 AS relatedness',
    'WHERE relatedness >= $floor',
    'WITH wanted, n, relatedness',
    'ORDER BY relatedness DESC, n.id',
    'WITH wanted.id AS turn_id,',
    `     head(collect({ id: n.id, text: n.${MEMORY_PROPERTIES.text}, relatedness: relatedness })) AS best`,
    'RETURN turn_id, best.id AS id, best.text AS text, best.relatedness AS relatedness',
    'LIMIT $limit',
  ].join('\n');

  return {
    cypher,
    parameters: { ...turn.parameters, ...entity.parameters, ...claim.parameters },
  };
}

function mapRow(row: Row): RelatedClaimRow | undefined {
  const text = ((row.text as string | null) ?? '').trim();
  const id = (row.id as string | null) ?? '';
  if (id.length === 0 || text.length === 0) {
    return undefined;
  }
  return {
    turnId: row.turn_id as string,
    id,
    text,
    relatedness: typeof row.relatedness === 'number' ? row.relatedness : 0,
  };
}

/**
 * One row per turn that has a claim in its family, and no row for a turn that has none. One
 * statement for the whole batch, because the annotation is worth a query per pack and never a
 * query per item.
 */
export async function findRelatedClaims(
  driver: Driver,
  input: RelatedClaimInput,
): Promise<readonly RelatedClaimRow[]> {
  if (input.turns.length === 0) {
    return [];
  }
  const statement = relatedClaimsStatement(input.mode);
  const rows = await runRead(
    driver,
    statement.cypher,
    {
      ...statement.parameters,
      turns: input.turns.map((request) => ({ id: request.id, textNorm: request.textNorm })),
      turnLabel: TURN_LABEL,
      floor: input.floor,
      minNameLength: toGraphInteger(MIN_SUBJECT_NAME_LENGTH),
      limit: toGraphInteger(input.turns.length),
    },
    mapRow,
  );
  return rows.filter((row): row is RelatedClaimRow => row !== undefined);
}
