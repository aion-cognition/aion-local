import type { EntityMergeDecision } from '@aion/core/infrastructure/sqlite/entity-merge-decisions.js';

import type { CascadeCase, CascadeCaseClass } from './entity-cascade-precision.fixture.js';

/**
 * The precision and recall arithmetic for the entity-cascade battery, split out of the test file
 * to keep it under the repo's line cap. Every function here takes the scored rows and decisions
 * as arguments rather than closing over module state, so the battery stays the only place that
 * owns the run.
 *
 * It is battery material like the fixture beside it, not shipped code, so the package build
 * excludes the suffix and `tsconfig.tests.json` is what type-checks it. That is also what lets
 * it reach core by subpath: only the lint-wide project maps `@aion/core/*` onto the sources.
 */

export type SeededCase = {
  readonly entry: CascadeCase;
  readonly leftId: string;
  readonly rightId: string;
  /** Cosine between the two stored name vectors, which is what tier 1's search scores. */
  readonly cosine: number;
  /** What the stage reported for the run over this case's shared episode. */
  readonly judged: number;
};

export type Scored = SeededCase & {
  readonly merged: boolean;
  /** Absent when nothing merged the pair. */
  readonly tier?: EntityMergeDecision['tier'];
  /** True when the two passes split and the pair went to the residue lane instead. */
  readonly proposed: boolean;
  readonly correct: boolean;
};

/** The decision that merged exactly this pair, whichever side ended up canonical. */
export function decisionFor(
  row: SeededCase,
  all: readonly EntityMergeDecision[],
): EntityMergeDecision | undefined {
  const wanted = [row.leftId, row.rightId].sort().join(',');
  return all.find(
    (decision) =>
      [...new Set([decision.canonicalId, ...decision.memberIds])].sort().join(',') === wanted,
  );
}

export function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function truePositives(scored: readonly Scored[]): number {
  return scored.filter((row) => row.merged && row.entry.duplicate).length;
}

/** Every merge that is not one of the twelve duplicates, cross-case merges included. */
export function falsePositives(
  scored: readonly Scored[],
  decisions: readonly EntityMergeDecision[],
): number {
  const withinCase = scored.filter((row) => row.merged && !row.entry.duplicate).length;
  return withinCase + crossCaseDecisions(scored, decisions).length;
}

export function crossCaseDecisions(
  scored: readonly Scored[],
  decisions: readonly EntityMergeDecision[],
): EntityMergeDecision[] {
  const owned = new Set(scored.map((row) => decisionFor(row, decisions)?.id));
  return decisions.filter((decision) => !owned.has(decision.id));
}

export function precision(
  scored: readonly Scored[],
  decisions: readonly EntityMergeDecision[],
): number {
  const tp = truePositives(scored);
  return ratio(tp, tp + falsePositives(scored, decisions));
}

/** Every merge tier 3 made, which is the only population the shipped mode governs. */
export function judgedMerges(scored: readonly Scored[]): Scored[] {
  return scored.filter((row) => row.tier === 'tier3');
}

/**
 * Precision over tier 3 alone. The headline number includes tier 0, which is right for the
 * question "what does the cascade merge wrongly"; it is the wrong number for the question the
 * pre-registered rule answers, since the mode governs tier 3 and nothing else.
 */
export function judgedPrecision(
  scored: readonly Scored[],
  decisions: readonly EntityMergeDecision[],
): number {
  const judged = judgedMerges(scored);
  const hits = judged.filter((row) => row.entry.duplicate).length;
  const misses =
    judged.filter((row) => !row.entry.duplicate).length +
    crossCaseDecisions(scored, decisions).filter((decision) => decision.tier === 'tier3').length;
  return ratio(hits, hits + misses);
}

/** The three outcomes a pair can reach, named for the line the battery prints on a miss. */
export function didWhat(row: Scored): string {
  if (row.merged) {
    return `merged at ${String(row.tier)}`;
  }
  if (row.proposed) {
    return 'split the two passes and queued the pair';
  }
  return 'left them apart with no proposal';
}

export function tierOf(scored: readonly Scored[], caseClass: CascadeCaseClass): string {
  const rows = scored.filter((row) => row.entry.caseClass === caseClass);
  const correct = rows.filter((row) => row.correct).length;
  return `${String(correct)}/${String(rows.length)}`;
}
