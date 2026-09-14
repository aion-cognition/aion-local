import type { SupersedesLineageRow } from '../../infrastructure/graph/judgment-durability-queries.js';

/**
 * The judgment-durability sense: how long a supersession stands before something reverses it,
 * grouped by the writer's own provenance tag rather than by a taxonomy this file invents.
 *
 * The time axis is system time throughout: `createdAt` and `reopenedAt` are both when the
 * substrate itself wrote a change, never when the world changed. A long-surviving judgment has
 * not been proven correct, only unreversed within the window this read covers; a short one is
 * not necessarily a mistake, since a world-time fact (a role change, a new address) closes just
 * as fast as a wrong inference does. This reader cannot tell the two apart and does not try to.
 */

const UNSPECIFIED_PROVENANCE = 'unspecified';

export type JudgmentDurabilityGroup = {
  /** The first provenance tag the writer recorded; `unspecified` for an edge that carries none. */
  readonly producedBy: string;
  /** Currently in effect: has survived the window so far, not proven correct by it. */
  readonly survived: number;
  /** Reopened at least once, on the record this read can see. */
  readonly reversed: number;
  /**
   * Closed by something other than `unsupersedeNode` (no `reopenedAt` on a closed edge), kept
   * apart because this reader has no producer for that transition to name.
   */
  readonly closedOther: number;
  /**
   * Currently open but carrying a `reopenedAt` stamp from an earlier generation: a later
   * `supersede()` call reused the same edge and reopened it through the generic merge policy,
   * which does not clear the earlier reopen stamp. Counted in `survived`, flagged here so a
   * reader does not mistake the stale timestamp for a still-reversed edge.
   */
  readonly staleReopenStamp: number;
  /** Milliseconds since `createdAt`, for the `survived` population, ascending. */
  readonly survivedAgeMs: readonly number[];
  /** Milliseconds from `createdAt` to `reopenedAt`, for the `reversed` population, ascending. */
  readonly reversalDurationMs: readonly number[];
};

export type JudgmentDurabilitySummary = {
  readonly asOf: string;
  readonly totalEdges: number;
  readonly groups: readonly JudgmentDurabilityGroup[];
};

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

type MutableGroup = {
  producedBy: string;
  survived: number;
  reversed: number;
  closedOther: number;
  staleReopenStamp: number;
  survivedAgeMs: number[];
  reversalDurationMs: number[];
};

function groupFor(groups: Map<string, MutableGroup>, producedBy: string): MutableGroup {
  const existing = groups.get(producedBy);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableGroup = {
    producedBy,
    survived: 0,
    reversed: 0,
    closedOther: 0,
    staleReopenStamp: 0,
    survivedAgeMs: [],
    reversalDurationMs: [],
  };
  groups.set(producedBy, created);
  return created;
}

/**
 * Classifies the full supersession-edge population read from the graph, one row per edge
 * instance. Every row lands in exactly one of `survived`, `reversed` or `closedOther`, so the
 * three counts always sum to `totalEdges`.
 */
export function summarizeJudgmentDurability(
  rows: readonly SupersedesLineageRow[],
  now: Date,
): JudgmentDurabilitySummary {
  const groups = new Map<string, MutableGroup>();
  for (const row of rows) {
    const producedBy = row.provenance[0] ?? UNSPECIFIED_PROVENANCE;
    const group = groupFor(groups, producedBy);
    const { createdAt } = row;
    if (row.unreversed) {
      group.survived += 1;
      if (createdAt !== undefined) {
        group.survivedAgeMs.push(Math.max(0, now.getTime() - createdAt.getTime()));
      }
      if (row.reopenedAt !== undefined) {
        group.staleReopenStamp += 1;
      }
      continue;
    }
    if (row.reopenedAt === undefined) {
      group.closedOther += 1;
      continue;
    }
    group.reversed += 1;
    if (createdAt !== undefined) {
      group.reversalDurationMs.push(Math.max(0, row.reopenedAt.getTime() - createdAt.getTime()));
    }
  }

  return {
    asOf: now.toISOString(),
    totalEdges: rows.length,
    groups: [...groups.values()]
      .sort((left, right) => left.producedBy.localeCompare(right.producedBy))
      .map((group) => ({ ...group })),
  };
}

/** One line per population with a transition on record, for the tier-3 evidence block. */
export function describeJudgmentDurability(summary: JudgmentDurabilitySummary): readonly string[] {
  if (summary.totalEdges === 0) {
    return ['judgment durability: no supersession lineage recorded yet'];
  }
  const lines = summary.groups.map((group) => {
    const survivedAge = median(group.survivedAgeMs);
    const reversalTime = median(group.reversalDurationMs);
    const parts = [
      `${group.producedBy}: ${String(group.survived)} unreversed`,
      survivedAge === undefined ? '' : `(median age ${(survivedAge / 86_400_000).toFixed(1)}d)`,
      `, ${String(group.reversed)} reversed`,
      reversalTime === undefined
        ? ''
        : `(median ${(reversalTime / 86_400_000).toFixed(1)}d to reversal)`,
      group.closedOther > 0 ? `, ${String(group.closedOther)} closed by another writer` : '',
      group.staleReopenStamp > 0
        ? `, ${String(group.staleReopenStamp)} carry a stale reopen stamp from an earlier generation`
        : '',
    ];
    return parts.join(' ').replace(/\s+,/g, ',');
  });
  return [
    `judgment durability as of ${summary.asOf}, ${String(summary.totalEdges)} lineage edge(s), ` +
      'system-time axis (when the substrate changed the record, not whether the world changed):',
    ...lines,
  ];
}
