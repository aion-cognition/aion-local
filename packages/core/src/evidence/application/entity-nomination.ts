import { readRelationScope, type EvidenceDependencies } from './dependencies.js';
import type { EntitySide, ExcerptNomination } from './entity-excerpt-render.js';
import { readNodeState, REQUIRED_ROLES } from './judgment-required.js';
import type { JudgmentDeps, JudgmentPair } from './judgment.js';
import {
  incidenceOfSource,
  newestIncidentSources,
  type IncidentSource,
} from '../../infrastructure/sqlite/entity-incidence.js';
import { idAddress } from '../domain/address.js';
import { ENTITY_EXCERPT_LIMITS, type RequestBudget } from '../domain/budget.js';
import type { EvidenceIssue } from '../domain/result.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * Which sources an entity judgment reads, chosen without reading either entity's whole history.
 *
 * The proofs are the ones every judgment takes: both node states and every role an entity is
 * read through have to be counted before anything is chosen from them, and an entity with no
 * recorded source at all is still a gap. What changed is the membership. Each side gets a fixed
 * number of seats, and they are filled in this order: the episode that prompted the comparison,
 * the newest stated corrections, the newest sources both entities are recorded against, then each
 * side's own newest sources. A correction or an older shared exchange can matter more than a
 * dozen recent mentions, which is why recency is not the only way in. Every read asks for no
 * more rows than the seats left, and is charged for them before it runs.
 */

export type EntityNominee = {
  readonly sourceId: string;
  readonly nominatedAs: ExcerptNomination;
  /** The sides the committed view records the source against. Empty for an unlinked prompt. */
  readonly sides: readonly EntitySide[];
  readonly currency: 'open' | 'closed';
};

export type EntityNomination =
  | {
      readonly status: 'nominated';
      /** In the order the judge reads them. */
      readonly nominees: readonly EntityNominee[];
      /** Per side, whether a bounded read saw recorded sources it did not nominate. */
      readonly unreadSourcesRemain: readonly [boolean, boolean];
      /** Node states nobody proved current, reported after any abstention the reads find. */
      readonly stateIssues: readonly EvidenceIssue[];
    }
  | { readonly status: 'incomplete'; readonly issues: readonly EvidenceIssue[] };

const SIDES = [0, 1] as const;

const OWN_ROLES: readonly string[] = REQUIRED_ROLES.entity_judgment.map((entry) => entry.role);

const CORRECTION_ROLE = 'stated_correction';

/** Every role a side is read through, each of which has to be counted before any is read. */
const CONSULTED = [
  ...REQUIRED_ROLES.entity_judgment,
  { role: CORRECTION_ROLE, direction: 'in' } as const,
];

/** The most rows the prompting source's own lookup can return: two nodes, every role. */
const PROMPT_ROWS = SIDES.length * CONSULTED.length;

function scopesProved(
  deps: JudgmentDeps,
  nodeId: string,
  dependencies: EvidenceDependencies,
): boolean {
  let proved = true;
  for (const { role, direction } of CONSULTED) {
    const scope = readRelationScope(deps.db, {
      kind: 'node',
      endpointId: nodeId,
      scope: durableRoleScope(role, direction),
      empty: false,
    });
    if (scope.status === 'verified') {
      dependencies.add(scope.dependency);
    } else {
      proved = false;
    }
  }
  return proved;
}

function sourceGap(
  nodeId: string,
  reason: 'required_scope_missing' | 'budget_limit',
): EvidenceIssue {
  return { address: idAddress(nodeId), field: 'source_content', reason, required: true };
}

/** Two lists read side by side, first of each, then second of each, so neither side goes last. */
function alternating<T>(lists: readonly (readonly T[])[]): T[] {
  const longest = Math.max(0, ...lists.map((list) => list.length));
  const merged: T[] = [];
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      const entry = list[index];
      if (entry !== undefined) {
        merged.push(entry);
      }
    }
  }
  return merged;
}

/**
 * One pair's seats and what has filled them, so no source is nominated twice. Every read it makes
 * is charged before it runs, and a refused charge reads nothing and marks the nomination bounded.
 */
class Seats {
  readonly nominees: EntityNominee[] = [];
  readonly free: [number, number] = [
    ENTITY_EXCERPT_LIMITS.sourcesPerSide,
    ENTITY_EXCERPT_LIMITS.sourcesPerSide,
  ];
  /** Per side, whether any source is recorded against it in its own roles, read or not. */
  readonly recorded: [boolean, boolean] = [false, false];
  readonly unread: [boolean, boolean] = [false, false];
  /** A charge was refused, so what the reads found is not all there was to find. */
  bounded = false;
  readonly #deps: JudgmentDeps;
  readonly #budget: RequestBudget;
  readonly #taken = new Set<string>();

  constructor(deps: JudgmentDeps, budget: RequestBudget) {
    this.#deps = deps;
    this.#budget = budget;
  }

  take(nominee: EntityNominee, ownRole: boolean): void {
    this.nominees.push(nominee);
    this.#taken.add(nominee.sourceId);
    for (const side of nominee.sides) {
      this.free[side] -= 1;
      if (ownRole) {
        this.recorded[side] = true;
      }
    }
  }

  #charged(rows: number): boolean {
    if (this.#budget.chargeRelationRows(rows) !== undefined) {
      this.bounded = true;
      return false;
    }
    return true;
  }

  /** One node's newest sources in the given roles, leaving out every source already seated. */
  newest(input: {
    readonly nodeId: string;
    readonly roles: readonly string[];
    readonly alsoIncidentTo?: string;
    readonly limit: number;
  }): readonly IncidentSource[] {
    if (input.limit <= 0 || !this.#charged(input.limit)) {
      return [];
    }
    return newestIncidentSources(this.#deps.db, { ...input, exclude: [...this.#taken] });
  }

  /**
   * The prompting source, seated on whichever sides it is recorded against. A source recorded
   * against neither is still read, since it is where the comparison came from.
   */
  prompt(nodeIds: readonly [string, string], sourceId: string): void {
    if (!this.#charged(PROMPT_ROWS)) {
      return;
    }
    const rows = incidenceOfSource(this.#deps.db, {
      sourceId,
      nodeIds,
      roles: CONSULTED.map((entry) => entry.role),
      limit: PROMPT_ROWS,
    });
    const sides = SIDES.filter((side) => rows.some((row) => row.nodeId === nodeIds[side]));
    this.take(
      {
        sourceId,
        nominatedAs: 'prompting',
        sides,
        currency:
          rows.length === 0 || rows.some((row) => row.currency === 'open') ? 'open' : 'closed',
      },
      false,
    );
    for (const side of SIDES) {
      if (rows.some((row) => row.nodeId === nodeIds[side] && OWN_ROLES.includes(row.role))) {
        this.recorded[side] = true;
      }
    }
  }
}

export function nominateEntitySources(
  deps: JudgmentDeps,
  pair: JudgmentPair,
  budget: RequestBudget,
  dependencies: EvidenceDependencies,
): EntityNomination {
  const nodeIds = [pair.sides[0].nodeId, pair.sides[1].nodeId] as const;
  const stateIssues = nodeIds.flatMap((nodeId) => {
    const issue = readNodeState(deps, nodeId, dependencies);
    return issue === undefined ? [] : [issue];
  });
  const unproved = nodeIds.filter((nodeId) => !scopesProved(deps, nodeId, dependencies));
  if (unproved.length > 0) {
    return {
      status: 'incomplete',
      issues: [
        ...stateIssues,
        ...unproved.map((nodeId) => sourceGap(nodeId, 'required_scope_missing')),
      ],
    };
  }

  const seats = new Seats(deps, budget);
  if (pair.promptingSourceId !== undefined) {
    seats.prompt(nodeIds, pair.promptingSourceId);
  }
  const corrections = SIDES.map((side) => {
    const limit = seats.free[side];
    const rows = seats.newest({
      nodeId: nodeIds[side],
      roles: [CORRECTION_ROLE],
      limit,
    });
    for (const row of rows) {
      seats.take({ ...row, nominatedAs: 'correction', sides: [side] }, false);
    }
    // A full page of corrections may not be all of them, and nothing here counts the rest.
    seats.unread[side] ||= limit > 0 && rows.length === limit;
    return rows;
  });
  const shared = seats.newest({
    nodeId: nodeIds[0],
    roles: OWN_ROLES,
    alsoIncidentTo: nodeIds[1],
    limit: Math.min(...seats.free),
  });
  for (const row of shared) {
    seats.take({ ...row, nominatedAs: 'shared', sides: [0, 1] }, true);
  }
  const recent = SIDES.map((side) => {
    const limit = seats.free[side];
    // One row past the seats, read only to learn whether more are recorded than were nominated.
    const rows = seats.newest({
      nodeId: nodeIds[side],
      roles: OWN_ROLES,
      limit: limit + 1,
    });
    seats.recorded[side] ||= rows.length > 0;
    seats.unread[side] ||= rows.length > limit;
    const kept = rows.slice(0, limit);
    for (const row of kept) {
      seats.take({ ...row, nominatedAs: 'recent', sides: [side] }, true);
    }
    return kept;
  });

  // The same rule a whole read held: a side with no recorded source has nothing to be judged on.
  const empty = SIDES.filter((side) => !seats.recorded[side]);
  if (empty.length > 0) {
    return {
      status: 'incomplete',
      issues: [
        ...stateIssues,
        ...empty.map((side) =>
          sourceGap(nodeIds[side], seats.bounded ? 'budget_limit' : 'required_scope_missing'),
        ),
      ],
    };
  }
  const byId = new Map(seats.nominees.map((nominee) => [nominee.sourceId, nominee]));
  const inOrder = (rows: readonly { readonly sourceId: string }[]): EntityNominee[] =>
    rows.flatMap((row) => {
      const nominee = byId.get(row.sourceId);
      return nominee === undefined ? [] : [nominee];
    });
  return {
    status: 'nominated',
    nominees: [
      ...seats.nominees.filter((nominee) => nominee.nominatedAs === 'prompting'),
      ...inOrder(alternating(corrections)),
      ...inOrder(shared),
      ...inOrder(alternating(recent)),
    ],
    unreadSourcesRemain: [seats.unread[0], seats.unread[1]],
    stateIssues,
  };
}
