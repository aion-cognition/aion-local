import { DEFAULTS } from '@aion/core';
import { describe, expect, it, vi } from 'vitest';

import { renderStats, runStats, type StatsSnapshot } from './stats.js';
import { renderStatus, type StatusSnapshot } from './status.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const SNAPSHOT: StatsSnapshot = {
  neo4j: { uri: 'bolt://neo4j:7687', reachable: true, detail: 'Neo4j/2026.07.1' },
  ollama: {
    url: 'http://host.docker.internal:11434',
    reachable: true,
    models: ['nomic-embed-text:latest', 'qwen3:1.7b'],
  },
  graph: { nodes: 42, relationships: 60 },
  queue: {
    depthByLane: { interactive: 1, bulk: 2 },
    oldestUnclaimedMs: 45_000,
    exhausted: 0,
    reinforcementDropped: 0,
    p95EnrichmentLagMs: 3_000,
    cueDegradedRate: 0.05,
    supersessionProposalsOpen: 1,
    entityMergeProposalsOpen: 0,
  },
  plasticity: {
    reinforcement: {
      signalsApplied: 10,
      pairsApplied: 4,
      edgesUpdated: 4,
      lastRunAt: '2026-08-27T00:00:00.000Z',
    },
    reinforcementDropped: 0,
    reinforcementQueueDepth: 2,
    decay: { edgesScanned: 20, edgesDecayed: 3, lastRunAt: '2026-08-27T00:00:00.000Z' },
  },
  edgeWeights: {
    SIMILAR: undefined,
    CO_OCCURS: { p50: 0.4, min: 0.1, p10: 0.15, p90: 0.85, max: 0.9, count: 5 },
    RELATED_TO: undefined,
  },
  extras: {
    labelCounts: new Map([
      ['AionNode', 42],
      ['Episode', 12],
      ['Entity', 8],
    ]),
    cadence: { totalCalls: 20, emptyPacks: 2 },
    sessionsServed: 4,
    methodCounters: {
      vector: 30,
      bm25: 10,
      activation: 8,
      resonance: 2,
      entity_resolution: 0,
      recency: 0,
      intention_trigger: 0,
    },
    methodLegStats: {
      vector: { sole: 22, shared: 8, rrfContribution: 1.234 },
      bm25: { sole: 6, shared: 4, rrfContribution: 0.456 },
      activation: { sole: 3, shared: 5, rrfContribution: 0.789 },
      resonance: { sole: 2, shared: 0, rrfContribution: 0 },
      entity_resolution: { sole: 0, shared: 0, rrfContribution: 0 },
      recency: { sole: 0, shared: 0, rrfContribution: 0 },
      intention_trigger: { sole: 0, shared: 0, rrfContribution: 0 },
    },
    generation: {
      routes: [
        {
          role: 'cue',
          provider: 'ollama',
          calls: 12,
          failed: 0,
          failureRate: 0,
          meanDurationMs: 900,
        },
        {
          role: 'cue',
          provider: 'anthropic',
          calls: 0,
          failed: 0,
          failureRate: undefined,
          meanDurationMs: undefined,
        },
        {
          role: 'reflect',
          provider: 'ollama',
          calls: 0,
          failed: 0,
          failureRate: undefined,
          meanDurationMs: undefined,
        },
        {
          role: 'reflect',
          provider: 'anthropic',
          calls: 8,
          failed: 2,
          failureRate: 0.25,
          meanDurationMs: 2_400,
        },
      ],
      calls: 20,
      failed: 2,
      failureRate: 0.1,
    },
    recallProbe: {
      samples: 8,
      hits: 6,
      hitRate: 0.75,
      served: {
        items: 12,
        referenced: 3,
        rate: 0.25,
        measuredAt: '2026-08-29T00:00:00.000Z',
      },
    },
    maintenance: {
      cycle: 41,
      operations: [
        {
          stats: {
            name: 'vector_backfill',
            runs: 3,
            improved: 2,
            unchanged: 1,
            failed: 0,
            unmeasured: 0,
            durationRuns: 3,
            durationTotalMs: 6_600,
            lastDurationMs: 2_100,
            lastRunAt: '2026-08-29T12:00:00.000Z',
            selectedCycle: 39,
          },
          lastStatus: 'applied',
          lastItemsAffected: 18,
        },
        {
          stats: {
            name: 'dead_letter',
            runs: 0,
            improved: 0,
            unchanged: 0,
            failed: 0,
            unmeasured: 0,
            durationRuns: 0,
            durationTotalMs: 0,
          },
        },
      ],
    },
    mergeShadow: {
      openWouldApply: 1,
      openWouldQueue: 2,
      autoMergeEnabled: true,
      autoMergedCount: 5,
    },
  },
};

const NOW = Date.parse('2026-08-29T12:04:00.000Z');

describe('stats output is a superset of status output', () => {
  it('renders every status line first, then appends the verbose extras', () => {
    const statusLines = collector();
    const statsLines = collector();
    const base: StatusSnapshot = { ...SNAPSHOT, extras: undefined };

    renderStatus(base, DEFAULTS, statusLines.write);
    renderStats(SNAPSHOT, DEFAULTS, statsLines.write, NOW);

    expect(statsLines.lines.slice(0, statusLines.lines.length)).toEqual(statusLines.lines);
    expect(statsLines.lines.length).toBeGreaterThan(statusLines.lines.length);
  });
});

describe('renderStats', () => {
  it('renders substrate counts by label, below the graph total the shared base view reports', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('Episode');
    expect(text).toContain('Entity');
    expect(text).toContain('graph    42 nodes, 60 relationships');
  });

  it('renders queue depth and plasticity counters from the shared base view', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('interactive=1 bulk=2');
    expect(text).toContain(
      'hebbian  reinforce 10 signals / 4 pairs / 4 edges (last run 2026-08-27T00:00:00.000Z), queue depth 2',
    );
    expect(text).toContain('decay    20 scanned / 3 decayed (last run 2026-08-27T00:00:00.000Z)');
  });

  it('renders cadence: calls per session and the empty-pack rate', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('calls        20 across 4 sessions (5.0 per session)');
    expect(text).toContain('empty packs  2 (10.0%)');
    // The degraded-cue rate is the shared base view's `recall` line; cadence does not repeat it.
    expect(text).toContain('recall   5.0% of recent recalls degraded on cues');
  });

  it('renders the spirit metric as a share of pack items per method', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write);

    const text = lines.join('\n');
    // 30 of 50 total items served came through the vector method.
    expect(text).toMatch(/vector\s+30\s+60\.0%/);
    expect(text).toMatch(/activation\s+8\s+16\.0%/);
  });

  it('renders sole finds, shared finds, and summed RRF contribution beside each method', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write);

    const text = lines.join('\n');
    // Activation's real share: `prefer` in fusion.ts explains 3 admitted items as activation's
    // own find and credits 5 more it shared with another leg, which the plain share above
    // could not distinguish from finding nothing on those 5.
    expect(text).toMatch(/activation\s+8\s+16\.0%\s+sole 3\s+shared 5\s+rrf 0\.789/);
    expect(text).toMatch(/vector\s+30\s+60\.0%\s+sole 22\s+shared 8\s+rrf 1\.234/);
  });

  it('lists a method with no pack items as zero rather than dropping its row', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write);

    const text = lines.join('\n');
    // entity_resolution and recency are zero in the fixture; the row must still print so a
    // method contributing nothing is a visible reading, not a silently missing line.
    expect(text).toMatch(/entity_resolution\s+0\s+0\.0%/);
    expect(text).toMatch(/recency\s+0\s+0\.0%/);
  });

  it('renders per-route generation calls and the failure rate beside them', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toMatch(/all routes\s+20\s+10\.0% failed/);
    expect(text).toMatch(/cue via ollama\s+12\s+0\.0% failed\s+~0\.9s\/call/);
    expect(text).toMatch(/reflect via anthropic\s+8\s+25\.0% failed\s+~2\.4s\/call/);
  });

  it('says a route nothing has called was never called, rather than reporting it clean', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toMatch(/cue via anthropic\s+0\s+never called/);
    expect(text).toMatch(/reflect via ollama\s+0\s+never called/);
  });

  it('says a substrate that has generated nothing has no reading yet', () => {
    const { lines, write } = collector();
    const fresh: StatsSnapshot = {
      ...SNAPSHOT,
      extras: {
        ...SNAPSHOT.extras,
        generation: {
          routes: SNAPSHOT.extras.generation.routes.map((route) => ({
            ...route,
            calls: 0,
            failed: 0,
            failureRate: undefined,
            meanDurationMs: undefined,
          })),
          calls: 0,
          failed: 0,
          failureRate: undefined,
        },
      },
    };

    renderStats(fresh, DEFAULTS, write, NOW);

    expect(lines.join('\n')).toMatch(/all routes\s+0\s+no generations yet/);
  });

  it('renders both self-probe rates, the lifetime one and the latest served reading', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toContain('recall self-probe');
    expect(text).toMatch(/recalled\s+6 of 8 asked back\s+75\.0%/);
    expect(text).toMatch(/referenced\s+3 of 12 served\s+25\.0% \(2026-08-29T00:00:00\.000Z\)/);
  });

  it('says a substrate nothing has probed is unmeasured rather than failing', () => {
    const { lines, write } = collector();
    const fresh: StatsSnapshot = {
      ...SNAPSHOT,
      extras: {
        ...SNAPSHOT.extras,
        recallProbe: { samples: 0, hits: 0, hitRate: undefined, served: undefined },
      },
    };

    renderStats(fresh, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toMatch(/recalled\s+nothing probed yet/);
    expect(text).toMatch(/referenced\s+not measured yet/);
  });

  it('says so when no served item was old enough for the run to judge', () => {
    const { lines, write } = collector();
    const quiet: StatsSnapshot = {
      ...SNAPSHOT,
      extras: {
        ...SNAPSHOT.extras,
        recallProbe: {
          ...SNAPSHOT.extras.recallProbe,
          served: {
            items: 0,
            referenced: 0,
            rate: undefined,
            measuredAt: '2026-08-29T00:00:00.000Z',
          },
        },
      },
    };

    renderStats(quiet, DEFAULTS, write, NOW);

    expect(lines.join('\n')).toMatch(/referenced\s+no served item older than a day/);
  });

  it('renders one maintenance line per registered operation, with the last outcome', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toContain('cycle 41, 2 operations registered');
    expect(text).toMatch(
      /vector_backfill\s+runs 3\s+improved 2\s+unchanged 1\s+failed 0\s+unmeasured 0\s+~2\.2s\/run\s+last 4m ago applied \(18 affected\)/,
    );
  });

  it('separates an operation that has never been selected from one that ran and changed nothing', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toMatch(/dead_letter\s+never selected/);
  });

  it('renders the open merge-shadow counts', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toContain('open        1 would auto-apply, 2 would queue');
  });

  it('renders the auto-merge knob state and the applied count', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, DEFAULTS, write, NOW);

    const text = lines.join('\n');
    expect(text).toContain('auto-merge  on, 5 applied to date');
  });

  it('says the auto-merge count is unavailable while Neo4j is down, next to the off state', () => {
    const { lines, write } = collector();
    const down: StatsSnapshot = {
      ...SNAPSHOT,
      extras: {
        ...SNAPSHOT.extras,
        mergeShadow: {
          openWouldApply: 1,
          openWouldQueue: 2,
          autoMergeEnabled: false,
          autoMergedCount: undefined,
        },
      },
    };

    renderStats(down, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('auto-merge  off, count unavailable while Neo4j is down');
  });

  it('says counts are unavailable when Neo4j is down, without dividing by zero on cadence', () => {
    const { lines, write } = collector();
    const down: StatsSnapshot = {
      ...SNAPSHOT,
      neo4j: { ...SNAPSHOT.neo4j, reachable: false, detail: 'connection refused' },
      graph: undefined,
      edgeWeights: undefined,
      queue: { ...SNAPSHOT.queue, cueDegradedRate: undefined },
      extras: {
        ...SNAPSHOT.extras,
        labelCounts: new Map(),
        cadence: { totalCalls: 0, emptyPacks: 0 },
        sessionsServed: 0,
      },
    };

    renderStats(down, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('graph    counts unavailable while Neo4j is down');
    expect(text).toContain('weights  unavailable while Neo4j is down');
    expect(text).toContain('calls        0 across 0 sessions');
    expect(text).toContain('empty packs  0');
    expect(text).toContain('recall   no recalls yet');
    // The per-label breakdown is skipped rather than printed as a misleading "empty" graph.
    expect(text).not.toContain('substrate');
  });
});

describe('aion stats argument handling', () => {
  it('prints its usage and exits 0 on --help', async () => {
    const { lines, write } = collector();

    expect(await runStats(['--help'], write)).toBe(0);

    expect(lines).toEqual(['usage: aion stats']);
  });

  // `aion stats --help` used to run stats, so an unknown flag has to be visible rather than
  // ignored by a command that reads no arguments.
  it('refuses an unknown flag rather than running', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const { lines, write } = collector();
    try {
      expect(await runStats(['--bogus'], write)).toBe(1);
    } finally {
      vi.restoreAllMocks();
    }

    expect(lines).toEqual([]);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("unknown option '--bogus' for stats");
    expect(String(stderr.mock.calls[1]?.[0])).toContain('usage: aion stats');
  });
});
