/**
 * The pure half of entity deduplication. A similarity search only ever
 * compares two nodes at a time, so this module turns the pairs one run found into connected
 * groups, picks the canonical member of each, and computes what the canonical keeps. None of
 * it touches the graph, which is what makes the selection rule testable without a server.
 */

export type DedupCandidate = {
  readonly id: string;
  readonly name: string;
  readonly isStructural: boolean;
  /**
   * Distinct current episodes that mention the identity. Every caller has to count it that way
   * or the rule below reads a different question: a sum over mention counts lets one episode
   * naming something forty times outweigh a year of history that named it once a week.
   */
  readonly mentionCount: number;
  readonly txFrom?: Date;
  readonly aliases: readonly string[];
  readonly accessCount: number;
  readonly lastAccessed?: Date;
};

export type DuplicatePair = {
  readonly a: string;
  readonly b: string;
};

/**
 * Transitive closure over this run's pairs, so three names within threshold of each other in
 * a chain (A~B, B~C) collapse into one group even though A and C were never compared directly.
 * Iterative union-find with path compression; singletons (nothing matched them) are dropped,
 * since a group of one has nothing to merge.
 */
export function groupDuplicates(pairs: readonly DuplicatePair[]): string[][] {
  const parent = new Map<string, string>();

  function find(id: string): string {
    if (!parent.has(id)) {
      parent.set(id, id);
    }
    let root = id;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) {
        break;
      }
      root = next;
    }
    let current = id;
    while (current !== root) {
      const next = parent.get(current);
      if (next === undefined) {
        break;
      }
      parent.set(current, root);
      current = next;
    }
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootB, rootA);
    }
  }

  for (const pair of pairs) {
    union(pair.a, pair.b);
  }

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const members = groups.get(root);
    if (members === undefined) {
      groups.set(root, [id]);
    } else {
      members.push(id);
    }
  }

  return [...groups.values()].filter((group) => group.length >= 2);
}

/**
 * Merge on collision: a structural node is never the absorbed side, so it wins outright
 * whenever the group has one (there should be at most one, since duplicate structural
 * identities of the same type cannot arise from `bootstrapBackbone`). Otherwise the stronger
 * identity wins: more distinct episodes have mentioned it, or, on a tie, it is the older of the
 * two. `id` breaks anything still tied, so the choice is always deterministic.
 */
export function selectCanonical<T extends DedupCandidate>(members: readonly T[]): T {
  const structural = members.filter((member) => member.isStructural);
  const pool = structural.length > 0 ? structural : members;
  return pool.reduce((strongest, candidate) =>
    isStronger(candidate, strongest) ? candidate : strongest,
  );
}

function isStronger(candidate: DedupCandidate, current: DedupCandidate): boolean {
  if (candidate.mentionCount !== current.mentionCount) {
    return candidate.mentionCount > current.mentionCount;
  }
  const candidateTx = candidate.txFrom?.getTime() ?? Number.POSITIVE_INFINITY;
  const currentTx = current.txFrom?.getTime() ?? Number.POSITIVE_INFINITY;
  if (candidateTx !== currentTx) {
    return candidateTx < currentTx;
  }
  return candidate.id < current.id;
}

/**
 * The absorbed names, plus whatever either side already answered to, minus the canonical's
 * own current name (that is an identity, not an alias of itself). Sorted for a deterministic
 * property write.
 */
export function mergeAliases(canonicalName: string, members: readonly DedupCandidate[]): string[] {
  const collected = new Set<string>();
  for (const member of members) {
    for (const alias of member.aliases) {
      collected.add(alias);
    }
    collected.add(member.name);
  }
  collected.delete(canonicalName);
  return [...collected].sort();
}

/** Sum, not max: every mention any merged identity carried belongs to the one identity that remains. */
export function mergeAccessCount(members: readonly DedupCandidate[]): number {
  return members.reduce((total, member) => total + member.accessCount, 0);
}

/** The most recent access across the group; absent when nothing in the group has ever been accessed. */
export function mergeLastAccessed(members: readonly DedupCandidate[]): Date | undefined {
  return members.reduce<Date | undefined>((latest, member) => {
    if (member.lastAccessed === undefined) {
      return latest;
    }
    if (latest === undefined || member.lastAccessed > latest) {
      return member.lastAccessed;
    }
    return latest;
  }, undefined);
}

/**
 * Stamped on every decision record the cascade writes, and part of that record's idempotency
 * key. Bump it whenever a tier's rule or a judge prompt changes, so a re-decided merge lands
 * beside the old record instead of overwriting what the old prompts said. Phase 0.3's replay
 * runner is what reads two versions of the same decision against each other.
 */
export const ENTITY_CASCADE_VERSION = 'cascade-1';

/**
 * The operation-level idempotency key: `entity.merge:{canonicalId}:{sortedMergedIds}`.
 * Sorted and de-duplicated so the same group produces the same key regardless of discovery
 * order.
 */
export function entityMergeLedgerKey(canonicalId: string, mergedIds: readonly string[]): string {
  return `entity.merge:${canonicalId}:${[...new Set(mergedIds)].sort().join(',')}`;
}
