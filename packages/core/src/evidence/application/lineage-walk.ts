import { readRelationScope } from './dependencies.js';
import { MAX_LINEAGE_HOPS } from '../../infrastructure/graph/claim-lineage-queries.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';
import {
  committedIncidenceForNode,
  committedIncidenceForNodesAt,
  countCommittedIncidenceForNode,
  countCommittedIncidenceForNodeAt,
} from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  countStatedLinksOfKind,
  listStatedLinksOfKind,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  countCitationsFrom,
  isNarrativeRevisionNode,
  readCitationsFrom,
} from '../../infrastructure/sqlite/narrative-citations.js';
import { partOwnerSource } from '../../infrastructure/sqlite/reference-targets.js';
import type { RequestBudget } from '../domain/budget.js';
import { durableRoleScope, NARRATIVE_SCOPES } from '../domain/scopes.js';

/**
 * The bounded walk from a node's own sources back to where its chain ends.
 *
 * A step is not always a source. A caller states a derivation against whatever it holds: another
 * capture, one turn inside one, a retained interpretation the graph still has, or a published
 * revision that cited both. Each of those continues the chain in its own store, and a walk that
 * read only source-to-source derivations would stop at the first one that was not a source and
 * report the chain as ended there.
 *
 * Convergence is not a cycle. Two sources deriving from one parent is an ordinary DAG, and the
 * only thing that never ends is a branch that reaches an id already on its own path back. One
 * shared set cannot tell the two apart, so the path is what detects the loop and a separate
 * record of what has already been expanded is what keeps the walk from redoing work.
 *
 * The hop bound is not a bound on the work. Four hops of unbounded fan-out is unbounded, so every
 * frontier read is charged from a count against the request's own remaining allowance before its
 * rows exist, and a frontier the request cannot afford ends the branch short and says so.
 */

const DERIVATION = 'derived_from';

const CITATION_SCOPE = NARRATIVE_SCOPES[0];

/** What a step names, which decides the store the next hop is read from. */
export type StepKind = 'source' | 'part' | 'retained_node' | 'narrative';

type Step = { readonly id: string; readonly kind: StepKind };

export type Walk = {
  readonly roots: readonly string[];
  readonly lineage: readonly string[];
  /** False when a branch looped, hit the bound, or rested on a scope nobody counted. */
  readonly complete: boolean;
  /** Every scope the traversal actually read, so the revision names what the answer rests on. */
  readonly dependencies: readonly EvidenceDependency[];
};

function visibleAt(knownFrom: string | null, at: Date | undefined): boolean {
  return knownFrom !== null && (at === undefined || Date.parse(knownFrom) <= at.getTime());
}

/** The qualifier a stated link recorded, narrowed to the categories a walk can cross. */
function stepOf(qualifier: string, id: string): Step | undefined {
  if (qualifier === 'source' || qualifier === 'part' || qualifier === 'retained_node') {
    return { id, kind: qualifier };
  }
  return undefined;
}

class Frontier {
  readonly #db: SqliteHandle;
  readonly #at: Date | undefined;
  readonly #budget: RequestBudget | undefined;
  readonly roots = new Set<string>();
  readonly lineage = new Set<string>();
  readonly dependencies: EvidenceDependency[] = [];
  /** The shallowest depth each step was expanded at, which is what its allowance was worth. */
  readonly #expanded = new Map<string, number>();
  complete = true;

  constructor(db: SqliteHandle, at: Date | undefined, budget: RequestBudget | undefined) {
    this.#db = db;
    this.#at = at;
    this.#budget = budget;
  }

  /**
   * Charges what a frontier read is about to cost. A charge that does not fit spends nothing and
   * ends the branch: a bound applied to rows a read already returned has not bounded the read.
   */
  #afford(rows: number): boolean {
    if (this.#budget?.chargeRelationRows(rows) === undefined) {
      return true;
    }
    this.complete = false;
    return false;
  }

  /** Records one scope reading; an uncounted scope ends that branch short rather than silently. */
  #counted(kind: EvidenceDependency['kind'], endpointId: string, scope: string, empty: boolean) {
    const reading = readRelationScope(this.#db, { kind, endpointId, scope, empty });
    if (reading.status !== 'verified') {
      this.complete = false;
      return false;
    }
    this.dependencies.push(reading.dependency);
    return true;
  }

  /** A raw source: its stated parents, or the end of the chain where it states none. */
  #fromSource(id: string): readonly Step[] {
    const declared = countStatedLinksOfKind(this.#db, id, DERIVATION);
    if (!this.#afford(declared)) {
      return [];
    }
    const stated = listStatedLinksOfKind(this.#db, id, DERIVATION, declared).filter((link) =>
      visibleAt(link.knownFrom, this.#at),
    );
    if (
      !this.#counted(
        'source',
        id,
        durableRoleScope('stated_derivation', 'out'),
        stated.length === 0,
      )
    ) {
      return [];
    }
    if (stated.length === 0) {
      this.roots.add(id);
      return [];
    }
    return stated.flatMap((link) => {
      const step = stepOf(link.qualifier, link.toId);
      if (step === undefined) {
        // An id nothing accounts for is a statement the substrate cannot follow. It is not a
        // terminal root either, so the branch ends short and says so.
        this.complete = false;
        return [];
      }
      return [step];
    });
  }

  /** A retained interpretation: the captures it was extracted from, and what it cites. */
  #fromRetained(id: string): readonly Step[] {
    // Charged against the population this step is about to read, not the one a present read
    // would have found: a vanished projection counts zero over a chain that still holds origins.
    const declared =
      this.#at === undefined
        ? countCommittedIncidenceForNode(this.#db, id, 'extraction')
        : countCommittedIncidenceForNodeAt(this.#db, id, this.#at, 'extraction');
    if (!this.#afford(declared)) {
      return [];
    }
    const rows =
      this.#at === undefined
        ? committedIncidenceForNode(this.#db, id, 'extraction')
        : committedIncidenceForNodesAt(this.#db, [id], this.#at, 'extraction');
    const proved = this.#counted(
      'node',
      id,
      durableRoleScope('extraction', 'out'),
      rows.length === 0,
    );
    const cited = isNarrativeRevisionNode(this.#db, id, this.#at) ? this.#fromNarrative(id) : [];
    if (proved && rows.length === 0 && cited.length === 0) {
      // A retained node whose origin nobody recorded is a missing initial capture, which the
      // signed cut keeps apart from a chain that ended.
      this.complete = false;
    }
    return [...rows.map((row): Step => ({ id: row.sourceId, kind: 'source' })), ...cited];
  }

  /** A published revision: the targets it cited, which is its own step in the chain. */
  #fromNarrative(id: string): readonly Step[] {
    if (!this.#afford(countCitationsFrom(this.#db, id, this.#at))) {
      return [];
    }
    const citations = readCitationsFrom(this.#db, id, this.#at);
    if (!this.#counted('node', id, CITATION_SCOPE, citations.length === 0)) {
      return [];
    }
    return citations.flatMap((citation) => {
      const step = stepOf(citation.targetKind, citation.targetId);
      if (step === undefined) {
        this.complete = false;
        return [];
      }
      return [step];
    });
  }

  /** A part: the capture that holds it, which is where its own chain continues. */
  #fromPart(id: string): readonly Step[] {
    const owner = partOwnerSource(this.#db, id);
    if (owner === undefined) {
      this.complete = false;
      return [];
    }
    return [{ id: owner, kind: 'source' }];
  }

  #parentsOf(step: Step): readonly Step[] {
    if (step.kind === 'source') {
      return this.#fromSource(step.id);
    }
    if (step.kind === 'part') {
      return this.#fromPart(step.id);
    }
    if (step.kind === 'narrative') {
      return this.#fromNarrative(step.id);
    }
    return this.#fromRetained(step.id);
  }

  /**
   * One branch, depth-first, with the path it came down held open. A parent already on that path
   * is a loop; one merely seen before is a shared ancestor whose own chain was already walked.
   *
   * What was already walked depends on how much allowance it had left. A node first reached five
   * hops out ran out of bound before its own parents; the same node reached again one hop out has
   * four hops to spend, and skipping it would hide a root that is plainly in reach. So the memo
   * records the shallowest depth each step was expanded at and yields to anything shallower.
   */
  walk(step: Step, path: Set<string>, depth: number): void {
    this.lineage.add(step.id);
    if (depth > MAX_LINEAGE_HOPS) {
      this.complete = false;
      return;
    }
    const expandedAt = this.#expanded.get(step.id);
    if (expandedAt !== undefined && expandedAt <= depth) {
      return;
    }
    this.#expanded.set(step.id, depth);
    path.add(step.id);
    for (const parent of this.#parentsOf(step)) {
      this.lineage.add(parent.id);
      if (path.has(parent.id)) {
        this.complete = false;
        continue;
      }
      this.walk(parent, path, depth + 1);
    }
    path.delete(step.id);
  }
}

/**
 * The bounded parent walk over the stated records, from one node's own source occurrences.
 *
 * What an id IS decides which store its first hop is read from, and the records answer that. An id
 * the manifest calls a published revision node is a retained interpretation, so it enters as one
 * and the walk reads its extraction origins and the targets it cited. Entering every id as a raw
 * capture asked the stated-derivation scope of a node that has no stated derivations and no census
 * for that scope, which ended the branch at the node it started from — a walk from a narrative
 * could never reach anything. No new step kind and no new qualifier: this is the retained-node
 * route the walk already crosses when it arrives from a source.
 */
export function walkLineage(
  db: SqliteHandle,
  sourceIds: readonly string[],
  at: Date | undefined,
  budget?: RequestBudget,
): Walk {
  const frontier = new Frontier(db, at, budget);
  for (const id of new Set(sourceIds)) {
    const kind: StepKind = isNarrativeRevisionNode(db, id, at) ? 'retained_node' : 'source';
    frontier.walk({ id, kind }, new Set(), 0);
  }
  return {
    roots: [...frontier.roots].sort(),
    lineage: [...frontier.lineage],
    complete: frontier.complete,
    dependencies: frontier.dependencies,
  };
}
