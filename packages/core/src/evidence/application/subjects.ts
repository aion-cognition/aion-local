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

/** What one incidence read decided, and what it could not decide. */
type IncidenceReading = {
  readonly rows: readonly CommittedIncidence[];
  /** Rows the recorded proof could not place on an axis the read pinned. */
  readonly unplaced: readonly IntervalAxis[];
};

/**
 * The rows a temporal read may use, and the ones it had to withhold without being able to say
 * they were absent. Withholding an unplaceable row is right; reporting the remainder as the whole
 * set is not, so the axes that could not answer travel back with the rows that could.
 */
function selectLive(rows: readonly CommittedIncidence[], mode: ReadMode): IncidenceReading {
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
  return { rows: live, unplaced };
}

/**
 * The sources a claim was extracted from, at the vantage the request was checked against.
 *
 * The present rows answer for now. A question pinned in either timeline is answered from the
 * version chain, because today's projection carries neither the sources the claim had then nor
 * the intervals that say so, and a world-only question needs those intervals just as much as a
 * knowledge-time one does.
 */
function extractionSources(db: SqliteHandle, claimId: string, mode: ReadMode): IncidenceReading {
  const rows = isTimeTravel(mode)
    ? committedIncidenceForNodesAt(db, [claimId], mode.knownAt, 'extraction')
    : committedIncidenceForNode(db, claimId, 'extraction');
  return selectLive(rows, mode);
}

/** Entities the records say this claim's sources mention, with the source that carries each. */
function mentionedEntities(
  db: SqliteHandle,
  sources: readonly CommittedIncidence[],
  mode: ReadMode,
): {
  readonly mentions: readonly { readonly entityId: string; readonly sourceId: string }[];
  readonly unplaced: readonly IntervalAxis[];
} {
  const mentions: { readonly entityId: string; readonly sourceId: string }[] = [];
  const unplaced: IntervalAxis[] = [];
  for (const source of sources) {
    const held = isTimeTravel(mode)
      ? committedIncidenceForSourceAt(db, source.sourceId, mode.knownAt)
      : committedIncidenceForSource(db, source.sourceId);
    const reading = selectLive(
      held.filter((row) => row.role === 'mention'),
      mode,
    );
    unplaced.push(...reading.unplaced);
    for (const row of reading.rows) {
      mentions.push({ entityId: row.nodeId, sourceId: source.sourceId });
    }
  }
  return { mentions, unplaced };
}

/**
 * The entities behind an already-read mention set. Materialization only: the reading that decided
 * which mentions there are, and what could not be decided about them, happened before this and is
 * not repeated here.
 */
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
    try {
      reading = extractionSources(deps.db, claimId, input.context.mode);
      const mentioned = mentionedEntities(deps.db, reading.rows, input.context.mode);
      unplaced.push(...reading.unplaced, ...mentioned.unplaced);
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
