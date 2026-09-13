import type { Driver } from 'neo4j-driver';

import {
  findNarrativeFamilyIdentities,
  type NarrativeFamilyIdentity,
} from '../../infrastructure/graph/narrative-families.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { readFamilyFence } from '../../reflection/application/family-fence.js';
import { idAddress } from '../domain/address.js';
import { RequestBudget } from '../domain/budget.js';
import type { EvidenceIssue } from '../domain/result.js';

export type NarrativeRepresentation = {
  readonly family: NarrativeFamilyIdentity['family'];
  readonly sessions: readonly string[];
  readonly selection: 'selected' | 'not_selected' | 'unknown';
  readonly publication: 'established' | 'unknown';
  /** Immutable graph identity retained for one policy-only revalidation. */
  readonly identity?: NarrativeFamilyIdentity;
  /** Request-local issue identities let policy revalidation replace only the evidence it reread. */
  readonly policyIssues?: readonly EvidenceIssue[];
  readonly knownAtVantage?: false;
};

export type RepresentationReading = {
  readonly values: ReadonlyMap<string, NarrativeRepresentation>;
  readonly dependencies: readonly EvidenceDependency[];
  readonly issues: readonly EvidenceIssue[];
};

type ScopeSet = { readonly sessions: readonly string[]; readonly known: boolean };

/** Each immutable revision is expanded once within the request's shared allowance. */
class RepresentationReader {
  readonly values = new Map<string, NarrativeRepresentation>();
  readonly dependencies: EvidenceDependency[] = [];
  readonly rereadIds = new Set<string>();
  readonly issues: EvidenceIssue[] = [];
  readonly #db: SqliteHandle;
  readonly #context: CheckedReadContext;
  readonly #budget: RequestBudget;
  readonly #memo = new Map<string, ScopeSet>();
  #missing: 'unresolved_mapping' | 'budget_limit' | 'depth_limit' | 'cycle' = 'unresolved_mapping';

  constructor(db: SqliteHandle, context: CheckedReadContext, budget: RequestBudget) {
    this.#db = db;
    this.#context = context;
    this.#budget = budget;
  }

  issue(
    id: string,
    reason:
      | 'unverified_scope'
      | 'store_unavailable'
      | 'budget_limit'
      | 'unresolved_mapping'
      | 'depth_limit'
      | 'cycle'
      | 'pending_publication',
    field: 'narrative_revision' | 'representation_preference' = 'narrative_revision',
    required = true,
  ): void {
    this.issues.push({
      address: idAddress(id),
      field,
      reason,
      required,
    });
  }

  #sessions(nodeId: string, path: ReadonlySet<string>): ScopeSet | undefined {
    const memo = this.#memo.get(nodeId);
    if (memo !== undefined) {
      return memo;
    }
    if (path.has(nodeId) || path.size >= this.#budget.limits.lineageHops) {
      this.#missing = path.has(nodeId) ? 'cycle' : 'depth_limit';
      return undefined;
    }
    if (this.#budget.chargeRelationRows(1) !== undefined) {
      this.#missing = 'budget_limit';
      return undefined;
    }
    const chunk = this.#db
      .prepare(
        `SELECT c.session_id, r.known_from FROM chunk_revisions r
      JOIN chunks c ON c.chunk_id = r.chunk_id JOIN publication_intents i ON i.operation_id = r.operation_id
      WHERE r.node_id = ? AND r.state IN ('published','closed') AND i.state = 'acknowledged' AND r.known_from = i.known_from`,
      )
      .get(nodeId) as { session_id: string; known_from: string } | undefined;
    if (chunk !== undefined) {
      const answer = {
        sessions: [chunk.session_id],
        known:
          this.#context.mode.knownAt === undefined ||
          chunk.known_from <= this.#context.mode.knownAt.toISOString(),
      };
      this.#memo.set(nodeId, answer);
      return answer;
    }
    const overview = this.#db
      .prepare(
        `SELECT r.known_from, i.operation_id,
      length(CAST(i.payload_json AS BLOB)) AS bytes, json_array_length(i.payload_json, '$.members') AS members
      FROM overview_revisions r JOIN publication_intents i ON i.operation_id = r.operation_id
      WHERE r.node_id = ? AND r.state IN ('published','closed') AND i.state = 'acknowledged' AND r.known_from = i.known_from`,
      )
      .get(nodeId) as
      | { known_from: string; operation_id: string; bytes: number; members: number | null }
      | undefined;
    if (overview?.members === undefined || overview.members === null || overview.members <= 0) {
      return undefined;
    }
    if (
      this.#budget.chargeRelationRows(overview.members) !== undefined ||
      this.#budget.chargeMetadataBytes(overview.bytes) !== undefined
    ) {
      this.#missing = 'budget_limit';
      return undefined;
    }
    const stored = this.#db
      .prepare('SELECT payload_json FROM publication_intents WHERE operation_id = ?')
      .get(overview.operation_id) as { payload_json: string };
    const payload = JSON.parse(stored.payload_json) as { members: { nodeId?: unknown }[] };
    const next = new Set([...path, nodeId]);
    const sessions = new Set<string>();
    let known =
      this.#context.mode.knownAt === undefined ||
      overview.known_from <= this.#context.mode.knownAt.toISOString();
    for (const member of payload.members) {
      if (typeof member.nodeId !== 'string') {
        return undefined;
      }
      const child = this.#sessions(member.nodeId, next);
      if (child === undefined) {
        return undefined;
      }
      known &&= child.known;
      child.sessions.forEach((sessionId) => sessions.add(sessionId));
    }
    const answer = { sessions: [...sessions].sort(), known };
    this.#memo.set(nodeId, answer);
    return answer;
  }

  read(identity: NarrativeFamilyIdentity): void {
    this.#missing = 'unresolved_mapping';
    const { nodeId, family } = identity;
    let publication: NarrativeRepresentation['publication'] = 'established';
    let sessions: readonly string[] = [];
    let known = true;
    if (family === 'chunk' || family === 'overview') {
      const scope = this.#sessions(nodeId, new Set());
      if (scope === undefined) {
        publication = 'unknown';
        this.issue(nodeId, this.#missing);
        if (identity.sessionId !== undefined && family === 'chunk') {
          sessions = [identity.sessionId];
        }
      } else {
        ({ sessions, known } = scope);
      }
    } else {
      publication = 'unknown';
    }
    let selected: NarrativeRepresentation['selection'] = 'selected';
    let unproved = false;
    if (sessions.length === 0) {
      unproved = true;
      this.issue(nodeId, this.#missing, 'representation_preference');
    }
    for (const sessionId of sessions) {
      if (this.#budget.chargeRelationRows(1) !== undefined) {
        unproved = true;
        this.issue(nodeId, 'budget_limit', 'representation_preference');
        continue;
      }
      const reading = readFamilyFence(this.#db, sessionId, this.#context.mode.knownAt);
      if (reading === undefined) {
        unproved = true;
        this.issues.push(
          this.#context.mode.knownAt === undefined
            ? {
                address: idAddress(nodeId),
                field: 'representation_preference',
                reason: 'unverified_scope',
                required: true,
              }
            : {
                address: idAddress(nodeId),
                field: 'representation_preference',
                reason: 'unsupported_history',
                historyReason: 'not_recorded',
                required: true,
              },
        );
      } else {
        // One family: a session whose selection resolves selects the family every narrative is
        // published under, so a resolved reading is a bound dependency and nothing more.
        this.dependencies.push(reading.dependency);
      }
    }
    if (unproved) {
      selected = 'unknown';
    }
    if (!known) {
      selected = 'not_selected';
    }
    this.values.set(nodeId, {
      family,
      sessions,
      selection: selected,
      publication,
      identity,
      ...(known ? {} : { knownAtVantage: false as const }),
    });
  }
}

/** One SQLite snapshot prevents two candidates from selecting opposite sides of the same ACK. */
function readPolicies(
  db: SqliteHandle,
  identities: readonly NarrativeFamilyIdentity[],
  context: CheckedReadContext,
  budget: RequestBudget,
  idsAdmitted = false,
): RepresentationReading & { readonly rereadIds: ReadonlySet<string> } {
  const reader = new RepresentationReader(db, context, budget);
  try {
    db.transaction(() => {
      for (const identity of identities) {
        if (!idsAdmitted && budget.chargeIds(1) !== undefined) {
          reader.issue(identity.nodeId, 'budget_limit', 'representation_preference');
          reader.values.set(identity.nodeId, {
            family: identity.family,
            sessions: [],
            selection: 'unknown',
            publication: 'unknown',
            identity,
          });
          continue;
        }
        reader.rereadIds.add(identity.nodeId);
        reader.read(identity);
      }
    }).deferred();
  } catch {
    // Discard partial policy results: mixing that prefix with a later snapshot could mix families.
    reader.values.clear();
    reader.dependencies.length = 0;
    reader.issues.length = 0;
    // Every identity in this failed snapshot receives a replacement failure result.
    for (const identity of identities) {
      reader.rereadIds.add(identity.nodeId);
      reader.issue(identity.nodeId, 'store_unavailable', 'representation_preference');
      reader.values.set(identity.nodeId, {
        family: identity.family,
        sessions: [],
        selection: 'unknown',
        publication: 'unknown',
        identity,
      });
    }
  }
  for (const [id, value] of reader.values) {
    reader.values.set(id, {
      ...value,
      policyIssues: reader.issues.filter(
        (issue) => issue.address.kind === 'id' && issue.address.id === id,
      ),
    });
  }
  return reader;
}

/** The only interpretation of representation markers and committed session family preference. */
export async function readNarrativeRepresentations(
  deps: { readonly db: SqliteHandle; readonly driver: Driver },
  ids: readonly string[],
  context: CheckedReadContext,
  budget: RequestBudget,
): Promise<RepresentationReading> {
  let identities: readonly NarrativeFamilyIdentity[];
  try {
    identities = await findNarrativeFamilyIdentities(deps.driver, ids);
  } catch {
    return {
      values: new Map(
        ids.map((id) => [
          id,
          {
            family: 'unknown' as const,
            sessions: [],
            selection: 'unknown' as const,
            publication: 'unknown' as const,
          },
        ]),
      ),
      dependencies: [],
      issues: ids.map((id) => ({
        address: idAddress(id),
        field: 'representation_preference',
        reason: 'store_unavailable',
        required: true,
      })),
    };
  }
  return readPolicies(deps.db, identities, context, budget, true);
}

/**
 * One bounded policy reread after a declined serving completion. It reuses immutable identities,
 * opens no raw content, and performs no graph read, recovery, initialization or durable write.
 */
export function revalidateNarrativeRepresentations(
  db: SqliteHandle,
  values: ReadonlyMap<string, NarrativeRepresentation>,
  context: CheckedReadContext,
): RepresentationReading & { readonly rereadIds: ReadonlySet<string> } {
  const identities = [...values.values()].flatMap((value) =>
    value.identity === undefined ? [] : [value.identity],
  );
  const reading = readPolicies(db, identities, context, new RequestBudget());
  return {
    ...reading,
    rereadIds: reading.rereadIds,
    values: new Map([...values, ...reading.values]),
  };
}
