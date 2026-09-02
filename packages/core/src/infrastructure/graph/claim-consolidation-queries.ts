import type { Driver } from 'neo4j-driver';

import { BITEMPORAL_PROPERTIES, currentOnly } from './bitemporal.js';
import { COMMUNITY_PROPERTY } from './community-queries.js';
import { runRead } from './connection.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from './episodes.js';
import { EXTRACTION_TYPE } from './labels.js';
import { NARRATIVE_PROPERTIES } from './narrative-queries.js';
import { FACT_NODE_LABELS, isFactNodeLabel, type FactNodeLabel } from './supersession-queries.js';
import { toGraphInteger, type Row } from './values.js';

/**
 * The graph side of the subject axis: which neighbourhoods hold enough standing claims to be
 * worth compressing, what those claims are, and whether one member set has already been
 * consolidated. What counts as dense is not decided here; the operation derives that from the
 * distribution this module reports.
 *
 * The population is `FACT_NODE_LABELS` rather than `:Memory`, for the reason claim dedup draws
 * the same line: `:Memory` is the companion label every content node carries, and consolidating
 * over it would sweep sessions, episodes and narratives into a claim.
 */

/** What a consolidated claim stamps as its provenance, and what the idempotency read matches on. */
export const CONSOLIDATION_EXTRACTION_METHOD = 'consolidation';

const FACT_LABEL_EXPRESSION = FACT_NODE_LABELS.join('|');

/**
 * The session a claim came from, through the episode it was extracted from. Cognitive nodes
 * carry no `session_id` of their own, so the containment path is the only thing that can say
 * whether a neighbourhood spans sessions or is one session restating itself.
 */
const SESSION_PATH = `(n)-[:${EXTRACTION_TYPE}]->(:Episode)-[:${CONTAINMENT_TYPE}]->(s:Session)`;

export type ClaimCommunityProfile = {
  readonly community: number;
  /** Standing claims the community holds, which is the number the density floor is derived from. */
  readonly size: number;
  /** Distinct sessions those claims came from. */
  readonly sessions: number;
};

/**
 * Per-community claim counts and the session spread behind them, in stock Cypher: both counts
 * are taken in one aggregation, so the read needs no plugin the substrate may not have.
 *
 * The session count is a `count(DISTINCT)` over the optional path rather than a flatten of
 * per-claim lists. A claim with no session path yields a null `s`, which the count ignores and
 * the row survives: a community whose claims all reach no session reports zero sessions instead
 * of disappearing from the distribution the density floor is derived from. Consolidated claims
 * are exactly that case, since a consolidation is written with no `EXTRACTED_FROM` edge.
 */
const READ_PROFILES = [
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE ${currentOnly('n')} AND n.${COMMUNITY_PROPERTY} IS NOT NULL`,
  `OPTIONAL MATCH ${SESSION_PATH}`,
  `WITH n.${COMMUNITY_PROPERTY} AS community, count(DISTINCT n) AS size,`,
  '     count(DISTINCT s.id) AS session_count',
  'RETURN community, size, session_count',
  'ORDER BY size DESC, community ASC',
].join('\n');

export async function readClaimCommunityProfiles(driver: Driver): Promise<ClaimCommunityProfile[]> {
  return runRead(driver, READ_PROFILES, {}, (row: Row) => ({
    community: row.community as number,
    size: typeof row.size === 'number' ? row.size : 0,
    sessions: typeof row.session_count === 'number' ? row.session_count : 0,
  }));
}

export type ConsolidationCandidate = {
  readonly id: string;
  readonly label: FactNodeLabel;
  readonly text: string;
  readonly occurredAt?: Date;
};

const LOAD_COMMUNITY_CLAIMS = [
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE ${currentOnly('n')} AND n.${COMMUNITY_PROPERTY} = $community`,
  `RETURN n.id AS id, [label IN labels(n) WHERE label IN $labels][0] AS label,`,
  `       n.${MEMORY_PROPERTIES.text} AS text,`,
  `       n.${BITEMPORAL_PROPERTIES.occurredAt} AS occurred_at`,
  `ORDER BY n.${BITEMPORAL_PROPERTIES.occurredAt}, n.id`,
  'LIMIT $limit',
].join('\n');

/** The neighbourhood's standing claims, oldest first, so the synthesis reads them as a history. */
export async function loadCommunityClaims(
  driver: Driver,
  community: number,
  limit: number,
): Promise<ConsolidationCandidate[]> {
  if (limit <= 0) {
    return [];
  }
  const rows = await runRead(
    driver,
    LOAD_COMMUNITY_CLAIMS,
    {
      community: toGraphInteger(community),
      labels: [...FACT_NODE_LABELS],
      limit: toGraphInteger(limit),
    },
    (row: Row) => {
      const label = (row.label as string | null) ?? '';
      if (!isFactNodeLabel(label)) {
        return undefined;
      }
      const occurredAt = row.occurred_at instanceof Date ? row.occurred_at : undefined;
      return {
        id: row.id as string,
        label,
        text: (row.text as string | null) ?? '',
        ...(occurredAt === undefined ? {} : { occurredAt }),
      };
    },
  );
  return rows.filter((row): row is ConsolidationCandidate => row !== undefined);
}

export type StoredConsolidation = {
  readonly id: string;
  /** False once something superseded it, which is what tells a repair from a re-synthesis. */
  readonly open: boolean;
};

/**
 * The idempotency read. The coverage key is the identity of a member set, and it is held on the
 * claim the set produced rather than in a side table, so a re-run reads its own answer out of
 * the graph it is about to write to.
 */
const FIND_CONSOLIDATION_BY_COVERAGE_KEY = [
  `MATCH (n:${FACT_LABEL_EXPRESSION})`,
  `WHERE n.${MEMORY_PROPERTIES.extractionMethod} = $method`,
  `  AND n.${NARRATIVE_PROPERTIES.coverageKey} = $coverageKey`,
  `  AND n.${BITEMPORAL_PROPERTIES.forgottenAt} IS NULL`,
  `RETURN n.id AS id, n.${BITEMPORAL_PROPERTIES.validUntil} IS NULL AS open`,
  'ORDER BY n.id',
].join('\n');

export async function findConsolidationByCoverageKey(
  driver: Driver,
  coverageKey: string,
): Promise<StoredConsolidation[]> {
  return runRead(
    driver,
    FIND_CONSOLIDATION_BY_COVERAGE_KEY,
    { method: CONSOLIDATION_EXTRACTION_METHOD, coverageKey },
    (row: Row) => ({ id: row.id as string, open: row.open === true }),
  );
}
