import type { Driver } from 'neo4j-driver';

import { readRelationScope } from './dependencies.js';
import { loadEntityDedupDetails } from '../../infrastructure/graph/entity-dedup-queries.js';
import { isTimeTravel } from '../../infrastructure/graph/read-modes.js';
import { findClaimSubjects, type ClaimSubject } from '../../infrastructure/graph/subject-family.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNode,
  committedIncidenceForNodesAt,
  committedIncidenceForSource,
  committedIncidenceForSourceAt,
  type CommittedIncidence,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { evidenceRequestKey, idAddress, type EvidenceAddress } from '../domain/address.js';
import type { RequestBudget } from '../domain/budget.js';
import { evidenceResult, type EvidenceIssue, type EvidenceResult } from '../domain/result.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * Which entities a claim names, and how sure the substrate is that the list is whole.
 *
 * The graph reaches subjects by walking from the claim through its capture to the entities that
 * capture mentions, so an evicted capture breaks the walk without any entity having changed.
 * The durable incidence answers the same question from records that outlive the projection. An
 * empty answer from either one is only an empty subject list when a census says the scope was
 * counted: otherwise nobody has looked, which is a different thing to tell a judge.
 */

export type SubjectInput = {
  readonly claimIds: readonly string[];
  readonly context: CheckedReadContext;
  readonly budget: RequestBudget;
};

export type SubjectReading = {
  readonly results: ReadonlyMap<string, EvidenceResult<readonly ClaimSubject[]>>;
  readonly issues: readonly EvidenceIssue[];
  readonly dependencies: readonly EvidenceDependency[];
};

type SubjectDeps = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
};

function issueOn(
  address: EvidenceAddress,
  field: EvidenceIssue['field'],
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required: boolean,
): EvidenceIssue {
  return { address, field, reason, required };
}

/** The same subject without the description, which is a present value and not a historical one. */
function withoutGloss(subject: ClaimSubject): ClaimSubject {
  const { gloss, ...rest } = subject;
  return gloss === undefined ? subject : rest;
}

/** Whether a recorded end had already passed at the vantage, which an absent one never has. */
function stillOpenAt(stamp: string | undefined, at: Date): boolean {
  return stamp === undefined || Date.parse(stamp) > at.getTime();
}

/**
 * Whether an incidence row was a live link at the vantage it was selected for.
 *
 * The archive path answers the same question the graph join does, so it applies the same policy:
 * a retracted link is not a relationship, and a version that recorded its own close is retracted
 * from that moment. Handing back a closed row because the graph could no longer be walked would
 * turn a correct absence into a positive answer.
 */
function liveAt(row: CommittedIncidence, at: Date | undefined): boolean {
  if (row.currency === 'closed') {
    return false;
  }
  return at === undefined || (stillOpenAt(row.validUntil, at) && stillOpenAt(row.txUntil, at));
}

/**
 * The sources a claim was extracted from, at the vantage the request was checked against. The
 * present rows answer for now; an earlier question is answered from the version chain, because
 * today's projection cannot say which sources carried the claim then.
 */
function extractionSources(
  db: SqliteHandle,
  claimId: string,
  knownAt: Date | undefined,
): readonly CommittedIncidence[] {
  const rows =
    knownAt === undefined
      ? committedIncidenceForNode(db, claimId, 'extraction')
      : committedIncidenceForNodesAt(db, [claimId], knownAt, 'extraction');
  return rows.filter((row) => liveAt(row, knownAt));
}

/** Entities the records say this claim's sources mention, with the source that carries each. */
function mentionedEntities(
  db: SqliteHandle,
  claimId: string,
  knownAt: Date | undefined,
): readonly { readonly entityId: string; readonly sourceId: string }[] {
  const sources = extractionSources(db, claimId, knownAt);
  return sources.flatMap((source) =>
    (knownAt === undefined
      ? committedIncidenceForSource(db, source.sourceId)
      : committedIncidenceForSourceAt(db, source.sourceId, knownAt)
    )
      .filter((row) => row.role === 'mention' && liveAt(row, knownAt))
      .map((row) => ({ entityId: row.nodeId, sourceId: source.sourceId })),
  );
}

async function subjectsFromRecords(
  deps: SubjectDeps,
  claimId: string,
  knownAt: Date | undefined,
): Promise<readonly ClaimSubject[]> {
  const mentions = mentionedEntities(deps.db, claimId, knownAt);
  if (mentions.length === 0) {
    return [];
  }
  const details = await loadEntityDedupDetails(
    deps.driver,
    mentions.map((mention) => mention.entityId),
  );
  const byId = new Map(details.map((detail) => [detail.id, detail]));
  return mentions.flatMap((mention) => {
    const detail = byId.get(mention.entityId);
    if (detail === undefined) {
      return [];
    }
    const gloss = detail.description.trim();
    return [
      {
        entityId: detail.id,
        name: detail.name,
        nameNorm: detail.nameNorm,
        sourceEpisodeId: mention.sourceId,
        ...(gloss.length === 0 ? {} : { gloss }),
      },
    ];
  });
}

export async function readClaimSubjects(
  deps: SubjectDeps,
  input: SubjectInput,
): Promise<SubjectReading> {
  const results = new Map<string, EvidenceResult<readonly ClaimSubject[]>>();
  const issues: EvidenceIssue[] = [];
  const dependencies: EvidenceDependency[] = [];

  for (const claimId of [...new Set(input.claimIds)]) {
    const address = idAddress(claimId);
    if (input.budget.chargeIds(1) !== undefined) {
      const issue = issueOn(address, 'interpretation_text', 'budget_limit', false);
      issues.push(issue);
      results.set(
        evidenceRequestKey(address),
        evidenceResult({ address, residency: 'resident', issues: [issue] }),
      );
      continue;
    }

    let subjects: readonly ClaimSubject[];
    try {
      // The join runs at the vantage the request was checked against, so a source or an entity
      // that was not visible then is not part of the answer now.
      subjects = await findClaimSubjects(deps.driver, claimId, input.context.mode);
      if (subjects.length === 0) {
        subjects = await subjectsFromRecords(deps, claimId, input.context.mode.knownAt);
      }
    } catch {
      const issue = issueOn(address, 'interpretation_text', 'store_unavailable', true);
      issues.push(issue);
      results.set(
        evidenceRequestKey(address),
        evidenceResult({ address, residency: 'resident', issues: [issue] }),
      );
      continue;
    }

    const claimIssues: EvidenceIssue[] = [];
    // The join runs claim to source to entity, so the scopes it rests on are the claim's own
    // extraction and each contributing source's mentions. Asking the claim for a mention scope
    // would make a writer invent a relation it does not own.
    const sources = extractionSources(deps.db, claimId, input.context.mode.knownAt);
    const consulted = [
      {
        endpointId: claimId,
        scope: durableRoleScope('extraction', 'out'),
        empty: sources.length === 0,
      },
      ...sources.map((row) => ({
        endpointId: row.sourceId,
        scope: durableRoleScope('mention', 'out'),
        empty: false,
      })),
    ];
    let proved = consulted.length > 0;
    for (const entry of consulted) {
      const scope = readRelationScope(deps.db, { kind: 'node', ...entry });
      if (scope.status === 'verified') {
        dependencies.push(scope.dependency);
      } else {
        proved = false;
      }
    }
    if (!proved) {
      // An empty list nobody counted is unknown. Handing a judge an empty subject set on that
      // reading would let a missing census pass for a claim that names nobody.
      claimIssues.push(issueOn(address, 'ownership', 'unverified_scope', subjects.length === 0));
    }
    if (input.budget.chargeRelationRows(subjects.length) !== undefined) {
      claimIssues.push(issueOn(address, 'ownership', 'budget_limit', false));
    }
    // A description is the entity's current text, and the records keep no history of it. A
    // question about an earlier vantage is answered without it rather than with today's words
    // under an old date.
    const historical = isTimeTravel(input.context.mode);
    const disclosed = historical ? subjects.map(withoutGloss) : subjects;
    if (historical && subjects.some((subject) => subject.gloss !== undefined)) {
      claimIssues.push({
        address,
        field: 'interpretation_text',
        reason: 'unsupported_history',
        historyReason: 'not_recorded',
        required: false,
      });
    }
    issues.push(...claimIssues);
    results.set(
      evidenceRequestKey(address),
      evidenceResult({
        address,
        residency: 'resident',
        issues: claimIssues,
        value: disclosed,
      }),
    );
  }

  return { results, issues, dependencies };
}
