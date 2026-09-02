import { createHash, randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * What the cascade knew when it merged two entities. Every tier writes one row per merge, and
 * a merge with no row here is a merge nobody can argue with later: the unmerge operation cites
 * it to say which evidence was wrong, and a prompt change replays against the stored evidence
 * rather than against a graph that has since moved on.
 *
 * There is no confidence column and there will not be one. The doctrine is that a model's
 * self-reported certainty is not a quantity anything may threshold on, and a column nobody can
 * read is the only reliable way to keep a later caller from reading it. What the record carries
 * instead is `reasons`, the signals as measured, and the judge's two boolean verdicts with the
 * prose each pass argued.
 */

/**
 * Who decided. Tier 0 is deterministic name-form equality, tier 3 the two-pass judge, and
 * `human` a person applying a row from the review queue. Tiers 1 and 2 are absent because
 * neither decides anything: tier 1 nominates pairs and tier 2 assembles the facts tier 3 reads,
 * so a value for either would name a tier that never fires. A deterministic tier-2 rule would
 * add its own value when it exists.
 *
 * `reconciled` names the one case where the answer is that nobody knows: the graph states a
 * merge whose record never reached this table, and `merge_decision_reconcile` writes back what
 * the merge trail still holds. Naming the loss is the point, because the alternative is a row
 * claiming a tier decided something no evidence survives for.
 */
export type EntityMergeTier = 'tier0' | 'tier3' | 'human' | 'reconciled';

/** How the two names relate, as the name-form math reads them, never as prose about them. */
export type NameFormRelation = 'fold' | 'squash' | 'bigram' | 'none';

/**
 * One member's evidence against the canonical, as facts rather than as a score. A group merge
 * carries one of these per absorbed member, so the record stays citable whether the tier
 * settled a pair or a chain.
 *
 * Absence is not zero, and every field that can go unmeasured is optional so the record can say
 * so. `nominatingCosine` is missing when a graph signal nominated the pair and no vector did;
 * the four overlap fields are missing when the pair read returned no row at all, which happens
 * when a side lost currency between nomination and measurement; `temporalGapDays` is missing
 * when neither side has an episode to measure against. Zero-filling any of them would turn a
 * thing nobody looked at into evidence against the merge, which is backwards for two entities
 * first seen in different episodes, and a replay could not tell the fill from a measured zero.
 */
export type EntityMergeSignals = {
  readonly memberId: string;
  readonly nominatingCosine?: number;
  readonly sharedEpisodeCount?: number;
  readonly sharedEpisodeJaccard?: number;
  readonly neighborOverlapCount?: number;
  readonly neighborOverlapJaccard?: number;
  readonly temporalGapDays?: number;
  readonly nameFormRelation: NameFormRelation;
  /** Distinct episodes that mention each side: the strength signal canonical selection reads. */
  readonly canonicalMentionCount: number;
  readonly memberMentionCount: number;
};

/** One pass of the judge: the boolean it returned and the case it made for it. */
export type EntityMergeJudgePass = {
  readonly same: boolean;
  readonly rationale: string;
};

/** The detect pass and the adversarial review pass. Only unanimity merges, and both are kept. */
export type EntityMergeJudgeVerdicts = {
  readonly detect: EntityMergeJudgePass;
  readonly review: EntityMergeJudgePass;
};

export type EntityMergeDecision = {
  readonly id: string;
  readonly canonicalId: string;
  /** Sorted and deduplicated, which is also what the idempotency key is taken over. */
  readonly memberIds: readonly string[];
  readonly tier: EntityMergeTier;
  readonly reasons: readonly string[];
  readonly signals: readonly EntityMergeSignals[];
  /** Null for a deterministic tier, which reaches its answer without asking a model. */
  readonly judge: EntityMergeJudgeVerdicts | null;
  readonly cascadeVersion: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
};

export type EntityMergeDecisionInput = {
  readonly canonicalId: string;
  readonly memberIds: readonly string[];
  readonly tier: EntityMergeTier;
  readonly reasons: readonly string[];
  readonly signals: readonly EntityMergeSignals[];
  readonly judge?: EntityMergeJudgeVerdicts;
  readonly cascadeVersion: string;
  readonly createdAt?: string;
};

type EntityMergeDecisionRow = {
  id: string;
  canonical_id: string;
  member_ids: string;
  tier: string;
  reasons: string;
  signals: string;
  judge_verdicts: string | null;
  cascade_version: string;
  idempotency_key: string;
  created_at: string;
};

function normalizeMembers(memberIds: readonly string[]): string[] {
  return [...new Set(memberIds)].sort();
}

/**
 * sha256 over the canonical, the sorted members and the cascade version, with a separator no
 * id can contain, so `('ab', ['c'])` and `('a', ['bc'])` cannot collide. Bumping the cascade
 * version is therefore what makes a re-decided merge a new record rather than an overwrite of
 * the one the old prompts produced.
 */
export function entityMergeDecisionKey(
  canonicalId: string,
  memberIds: readonly string[],
  cascadeVersion: string,
): string {
  const parts = [canonicalId, normalizeMembers(memberIds).join(','), cascadeVersion];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

function toEntityMergeDecision(row: EntityMergeDecisionRow): EntityMergeDecision {
  return {
    id: row.id,
    canonicalId: row.canonical_id,
    memberIds: JSON.parse(row.member_ids) as string[],
    tier: row.tier as EntityMergeTier,
    reasons: JSON.parse(row.reasons) as string[],
    signals: JSON.parse(row.signals) as EntityMergeSignals[],
    judge:
      row.judge_verdicts === null
        ? null
        : (JSON.parse(row.judge_verdicts) as EntityMergeJudgeVerdicts),
    cascadeVersion: row.cascade_version,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

/**
 * Idempotent on the key: the same merge decided again under the same cascade version refreshes
 * the evidence and keeps the row's `created_at`, which is the date the merge actually happened.
 * A replay after a crash before the ledger mark therefore leaves one record, not two, and the
 * returned id is the one the first telling got.
 */
export function recordEntityMergeDecision(
  db: SqliteHandle,
  input: EntityMergeDecisionInput,
): string {
  const memberIds = normalizeMembers(input.memberIds);
  const key = entityMergeDecisionKey(input.canonicalId, memberIds, input.cascadeVersion);
  const row = db
    .prepare(
      `INSERT INTO entity_merge_decisions
         (id, canonical_id, member_ids, tier, reasons, signals, judge_verdicts,
          cascade_version, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO UPDATE SET
         canonical_id = excluded.canonical_id,
         member_ids = excluded.member_ids,
         tier = excluded.tier,
         reasons = excluded.reasons,
         signals = excluded.signals,
         judge_verdicts = excluded.judge_verdicts
       RETURNING id`,
    )
    .get(
      randomUUID(),
      input.canonicalId,
      JSON.stringify(memberIds),
      input.tier,
      JSON.stringify([...input.reasons]),
      JSON.stringify([...input.signals]),
      input.judge === undefined ? null : JSON.stringify(input.judge),
      input.cascadeVersion,
      key,
      input.createdAt ?? new Date().toISOString(),
    ) as { id: string };
  return row.id;
}

export function getEntityMergeDecision(
  db: SqliteHandle,
  id: string,
): EntityMergeDecision | undefined {
  const row = db.prepare('SELECT * FROM entity_merge_decisions WHERE id = ?').get(id) as
    EntityMergeDecisionRow | undefined;
  return row === undefined ? undefined : toEntityMergeDecision(row);
}

/**
 * The reader an unmerge reaches first: it recomputes the key from the canonical and the members
 * it is about to release, and only then does it hold a row id.
 */
export function getEntityMergeDecisionByKey(
  db: SqliteHandle,
  idempotencyKey: string,
): EntityMergeDecision | undefined {
  const row = db
    .prepare('SELECT * FROM entity_merge_decisions WHERE idempotency_key = ?')
    .get(idempotencyKey) as EntityMergeDecisionRow | undefined;
  return row === undefined ? undefined : toEntityMergeDecision(row);
}

/** Insertion order (rowid), not `created_at`: a burst inside one millisecond ties on the latter. */
export function listEntityMergeDecisions(db: SqliteHandle): EntityMergeDecision[] {
  const rows = db
    .prepare('SELECT * FROM entity_merge_decisions ORDER BY rowid ASC')
    .all() as EntityMergeDecisionRow[];
  return rows.map(toEntityMergeDecision);
}

/**
 * Every decision one entity took part in, from either side. `aion why` asks this of a node it
 * is explaining and an unmerge asks it of a canonical whose absorbed members it is naming, so
 * the member arm walks the stored JSON list rather than making the caller know which side its
 * id landed on.
 */
export function findEntityMergeDecisionsForEntity(
  db: SqliteHandle,
  entityId: string,
): EntityMergeDecision[] {
  const rows = db
    .prepare(
      `SELECT * FROM entity_merge_decisions
       WHERE canonical_id = ?
          OR EXISTS (SELECT 1 FROM json_each(member_ids) WHERE json_each.value = ?)
       ORDER BY rowid ASC`,
    )
    .all(entityId, entityId) as EntityMergeDecisionRow[];
  return rows.map(toEntityMergeDecision);
}
