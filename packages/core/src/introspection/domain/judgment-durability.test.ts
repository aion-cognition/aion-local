import { describe, expect, it } from 'vitest';

import { describeJudgmentDurability, summarizeJudgmentDurability } from './judgment-durability.js';
import type { SupersedesLineageRow } from '../../infrastructure/graph/judgment-durability-queries.js';

const NOW = new Date('2026-09-14T00:00:00.000Z');
const DAY_MS = 86_400_000;

function row(overrides: Partial<SupersedesLineageRow> = {}): SupersedesLineageRow {
  return {
    provenance: ['synthesis'],
    unreversed: true,
    createdAt: new Date(NOW.getTime() - DAY_MS),
    reopenedAt: undefined,
    ...overrides,
  };
}

describe('summarizeJudgmentDurability', () => {
  it('reports zero edges for a substrate with no supersession lineage', () => {
    const summary = summarizeJudgmentDurability([], NOW);

    expect(summary).toEqual({ asOf: NOW.toISOString(), totalEdges: 0, groups: [] });
  });

  it('groups by the first provenance tag, unspecified for an edge that carries none', () => {
    const summary = summarizeJudgmentDurability(
      [row({ provenance: ['synthesis'] }), row({ provenance: [] })],
      NOW,
    );

    expect(summary.groups.map((group) => group.producedBy).sort()).toEqual([
      'synthesis',
      'unspecified',
    ]);
  });

  it('classifies an open edge as survived, with its age since creation', () => {
    const summary = summarizeJudgmentDurability(
      [row({ unreversed: true, createdAt: new Date(NOW.getTime() - DAY_MS) })],
      NOW,
    );

    const [group] = summary.groups;
    expect(group).toMatchObject({ survived: 1, reversed: 0, closedOther: 0 });
    expect(group?.survivedAgeMs).toEqual([DAY_MS]);
  });

  it('classifies a reopened edge as reversed, with its time to reversal', () => {
    const reopenedAt = new Date(NOW.getTime() - DAY_MS / 2);
    const summary = summarizeJudgmentDurability(
      [row({ unreversed: false, createdAt: new Date(NOW.getTime() - DAY_MS), reopenedAt })],
      NOW,
    );

    const [group] = summary.groups;
    expect(group).toMatchObject({ survived: 0, reversed: 1, closedOther: 0 });
    expect(group?.reversalDurationMs).toEqual([DAY_MS / 2]);
  });

  it('classifies a closed edge with no reopen stamp as closed by another writer', () => {
    const summary = summarizeJudgmentDurability(
      [row({ unreversed: false, reopenedAt: undefined })],
      NOW,
    );

    expect(summary.groups[0]).toMatchObject({ survived: 0, reversed: 0, closedOther: 1 });
  });

  it('flags an open edge carrying a stale reopen stamp from an earlier generation, still counted as survived', () => {
    const summary = summarizeJudgmentDurability(
      [row({ unreversed: true, reopenedAt: new Date(NOW.getTime() - DAY_MS * 3) })],
      NOW,
    );

    expect(summary.groups[0]).toMatchObject({ survived: 1, staleReopenStamp: 1 });
  });

  it('still counts a row with no readable createdAt, just without an age sample for it', () => {
    const summary = summarizeJudgmentDurability(
      [row({ unreversed: true, createdAt: undefined })],
      NOW,
    );

    expect(summary.totalEdges).toBe(1);
    expect(summary.groups[0]).toMatchObject({ survived: 1, survivedAgeMs: [] });
  });

  it('sums survived, reversed and closedOther to the total edge count', () => {
    const summary = summarizeJudgmentDurability(
      [
        row({ unreversed: true }),
        row({ unreversed: false, reopenedAt: new Date() }),
        row({ unreversed: false, reopenedAt: undefined }),
      ],
      NOW,
    );

    const [group] = summary.groups;
    expect((group?.survived ?? 0) + (group?.reversed ?? 0) + (group?.closedOther ?? 0)).toBe(
      summary.totalEdges,
    );
  });
});

describe('describeJudgmentDurability', () => {
  it('names the system-time axis explicitly, distinct from whether the world changed', () => {
    const lines = describeJudgmentDurability(summarizeJudgmentDurability([row()], NOW));

    expect(lines[0]).toContain('system-time axis');
    expect(lines[0]).toContain('not whether the world changed');
  });

  it('states an empty population explicitly rather than staying silent', () => {
    expect(describeJudgmentDurability(summarizeJudgmentDurability([], NOW))).toEqual([
      'judgment durability: no supersession lineage recorded yet',
    ]);
  });

  it('reads as unreversed, never as proven correct', () => {
    const lines = describeJudgmentDurability(summarizeJudgmentDurability([row()], NOW));

    expect(lines.join(' ')).toContain('unreversed');
    expect(lines.join(' ')).not.toContain('correct');
  });
});
