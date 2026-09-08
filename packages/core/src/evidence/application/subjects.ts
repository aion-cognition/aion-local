import type { Driver } from 'neo4j-driver';

import { readRelationScope } from './dependencies.js';
import { loadEntityDedupDetails } from '../../infrastructure/graph/entity-dedup-queries.js';
import { isTimeTravel, type ReadMode } from '../../infrastructure/graph/read-modes.js';
import { findClaimSubjects, type ClaimSubject } from '../../infrastructure/graph/subject-family.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNode,
  committedIncidenceForNodesAt,
  committedIncidenceForSource,
  committedIncidenceForSourceAt,
  countCommittedIncidenceForNode,
  countCommittedIncidenceForNodeAt,
  countCommittedIncidenceForSource,
  countCommittedIncidenceForSourceAt,
  type CommittedIncidence,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { evidenceRequestKey, idAddress, type EvidenceAddress } from '../domain/address.js';
import type { RequestBudget } from '../domain/budget.js';
import { evaluateInterval, type IntervalAxis, type IntervalProof } from '../domain/interval.js';
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

/**
 * One incidence row's interval, as the records stated it. Built here and nowhere else, so every
 * temporal decision this path makes goes through the one evaluator in the domain.
 */
function proofOf(row: CommittedIncidence): IntervalProof {
  return {
    closed: row.currency === 'closed',
    ...(row.validFrom === undefined ? {} : { validFrom: row.validFrom }),
    ...(row.validUntil === undefined ? {} : { validUntil: row.validUntil }),
    ...(row.txFrom === undefined ? {} : { txFrom: row.txFrom }),
    ...(row.txUntil === undefined ? {} : { txUntil: row.txUntil }),
  };
}

/** What one incidence read decided, what it could not decide, and what it could not afford. */
type IncidenceReading = {
  readonly rows: readonly CommittedIncidence[];
  /** Rows the recorded proof could not place on an axis the read pinned. */
  readonly unplaced: readonly IntervalAxis[];
  /** True when the allowance could not carry the whole recorded population. */
  readonly trimmed: boolean;
};

/**
 * How much of a recorded population this request may still materialize.
 *
 * The count comes first and the rows come second, on the same population at the same vantage. A
 * bound applied to rows a read already returned has bounded nothing, and proof rows are read
 * rows: one examined and then excluded cost exactly as much to fetch as one that survived.
 */
function admit(
  budget: RequestBudget,
  declared: number,
): { readonly take: number; readonly trimmed: boolean } {
  const remaining = budget.limits.relationRows - budget.spent().relation_rows;
  const take = Math.max(0, Math.min(declared, remaining));
  if (take > 0) {
    budget.chargeRelationRows(take);
  }
  return { take, trimmed: take < declared };
}

/**
 * The rows a temporal read may use, the ones it had to withhold without being able to say they
 * were absent, and whether the allowance stopped it short of the whole population.
 */
function selectLive(
  rows: readonly CommittedIncidence[],
  mode: ReadMode,
  trimmed: boolean,
): IncidenceReading {
  const live: CommittedIncidence[] = [];
  const unplaced: IntervalAxis[] = [];
  for (const row of rows) {
    const decision = evaluateInterval(proofOf(row), mode);
    if (decision.status === 'visible') {
      live.push(row);
    } else if (decision.status === 'unknown') {
      unplaced.push(decision.axis);
    }
  }
  return { rows: live, unplaced, trimmed };
}

/**
 * The sources a claim was extracted from, at the vantage the request was checked against.
 *
 * The present rows answer for now. A question pinned in either timeline is answered from the
 * version chain, because today's projection carries neither the sources the claim had then nor
 * the intervals that say so, and a world-only question needs those intervals just as much as a
 * knowledge-time one does.
 */
function extractionSources(
  db: SqliteHandle,
  claimId: string,
  mode: ReadMode,
  budget: RequestBudget,
): IncidenceReading {
  const historical = isTimeTravel(mode);
  const declared = historical
    ? countCommittedIncidenceForNodeAt(db, claimId, mode.knownAt, 'extraction')
    : countCommittedIncidenceForNode(db, claimId, 'extraction');
  const { take, trimmed } = admit(budget, declared);
  return selectLive(readAdmitted(db, claimId, mode, take), mode, trimmed);
}

/** The admitted extraction rows, from the population the count was taken over. */
function readAdmitted(
  db: SqliteHandle,
  claimId: string,
  mode: ReadMode,
  take: number,
): readonly CommittedIncidence[] {
  if (take === 0) {
    return [];
  }
  return isTimeTravel(mode)
    ? committedIncidenceForNodesAt(db, [claimId], mode.knownAt, 'extraction', take)
    : committedIncidenceForNode(db, claimId, 'extraction', take);
}

/** Entities the records say this claim's sources mention, with the source that carries each. */
function mentionedEntities(
  db: SqliteHandle,
  sources: readonly CommittedIncidence[],
  mode: ReadMode,
  budget: RequestBudget,
): {
  readonly mentions: readonly { readonly entityId: string; readonly sourceId: string }[];
  readonly unplaced: readonly IntervalAxis[];
  readonly trimmed: boolean;
} {
  const mentions: { readonly entityId: string; readonly sourceId: string }[] = [];
  const unplaced: IntervalAxis[] = [];
  let trimmed = false;
  const historical = isTimeTravel(mode);
  for (const source of sources) {
    const declared = historical
      ? countCommittedIncidenceForSourceAt(db, source.sourceId, mode.knownAt, 'mention')
      : countCommittedIncidenceForSource(db, source.sourceId, 'mention');
    const admitted = admit(budget, declared);
    trimmed = trimmed || admitted.trimmed;
    if (admitted.take === 0) {
      continue;
    }
    const held = historical
      ? committedIncidenceForSourceAt(db, source.sourceId, mode.knownAt, {
          role: 'mention',
          limit: admitted.take,
        })
      : committedIncidenceForSource(db, source.sourceId, {
          role: 'mention',
          limit: admitted.take,
        });
    const reading = selectLive(held, mode, false);
    unplaced.push(...reading.unplaced);
    for (const row of reading.rows) {
      mentions.push({ entityId: row.nodeId, sourceId: source.sourceId });
    }
  }
  return { mentions, unplaced, trimmed };
}

async function materializeSubjects(
  deps: SubjectDeps,
  mentions: readonly { readonly entityId: string; readonly sourceId: string }[],
): Promise<readonly ClaimSubject[]> {
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

    // The durable incidence this claim rests on is read once and read on every path. The scope
    // check, the completeness proof and the archive fallback are three questions about the same
    // rows, and a graph answer is not a certificate over them: one resident origin returning a
    // subject says nothing about what a second origin's records could not place. Reading them
    // only when the join came back empty is how that second origin stayed hidden.
    let reading: IncidenceReading;
    let subjects: readonly ClaimSubject[];
    const unplaced: IntervalAxis[] = [];
    let trimmed = false;
    try {
      reading = extractionSources(deps.db, claimId, input.context.mode, input.budget);
      const mentioned = mentionedEntities(deps.db, reading.rows, input.context.mode, input.budget);
      unplaced.push(...reading.unplaced, ...mentioned.unplaced);
      trimmed = reading.trimmed || mentioned.trimmed ? true : trimmed;
      // The join runs at the vantage the request was checked against, so a source or an entity
      // that was not visible then is not part of the answer now.
      subjects = await findClaimSubjects(deps.driver, claimId, input.context.mode);
      if (subjects.length === 0) {
        subjects = await materializeSubjects(deps, mentioned.mentions);
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
    const { rows: sources } = reading;
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
    // A census proves how many relations there are, never what their missing dates were. A row
    // the recorded proof could not place is withheld from the answer and named here, so nothing
    // reports the remainder as the whole set for the moment asked about.
    for (const axis of new Set(unplaced)) {
      claimIssues.push({
        address,
        field: axis === 'world' ? 'link_interval' : 'reference_history',
        reason: 'unsupported_history',
        historyReason: 'not_recorded',
        required: true,
      });
    }
    // A population the allowance cut short is not the population the question asked about, so the
    // remainder is not certified: the address stays, its verified rows stay, and the gap is named.
    if (trimmed) {
      claimIssues.push(issueOn(address, 'ownership', 'budget_limit', true));
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
