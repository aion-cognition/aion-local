import { describe, expect, it } from 'vitest';

import { renderStats, type StatsSnapshot } from './stats.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const SNAPSHOT: StatsSnapshot = {
  neo4jReachable: true,
  labelCounts: new Map([
    ['AionNode', 42],
    ['Episode', 12],
    ['Entity', 8],
  ]),
  graph: { nodes: 42, relationships: 60 },
  queue: {
    depthByLane: { interactive: 1, bulk: 2 },
    oldestUnclaimedMs: 45_000,
    exhausted: 0,
    reinforcementDropped: 0,
    p95EnrichmentLagMs: 3_000,
    cueDegradedRate: 0.02,
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
  cadence: { totalCalls: 20, emptyPacks: 2 },
  sessionsServed: 4,
  degradedRate: 0.05,
  methodCounters: {
    vector: 30,
    bm25: 10,
    activation: 8,
    resonance: 2,
    entity_resolution: 0,
    recency: 0,
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
          lastRunAt: '2026-08-29T12:00:00.000Z',
          selectedCycle: 39,
        },
        lastStatus: 'applied',
        lastItemsAffected: 18,
      },
      {
        stats: { name: 'dead_letter', runs: 0, improved: 0, unchanged: 0, failed: 0 },
      },
    ],
  },
};

const NOW = Date.parse('2026-08-29T12:04:00.000Z');

describe('renderStats', () => {
  it('renders substrate counts by label and the graph total', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write);

    const text = lines.join('\n');
    expect(text).toContain('Episode');
    expect(text).toContain('Entity');
    expect(text).toContain('total: 42 nodes, 60 relationships');
  });

  it('renders queue depth and plasticity counters', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write);

    const text = lines.join('\n');
    expect(text).toContain('interactive=1 bulk=2');
    expect(text).toContain('reinforce  10 signals / 4 pairs / 4 edges');
    expect(text).toContain('decay      20 scanned / 3 decayed');
  });

  it('renders cadence: calls per session, empty-pack rate, degraded rate', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write);

    const text = lines.join('\n');
    expect(text).toContain('calls        20 across 4 sessions (5.0 per session)');
    expect(text).toContain('empty packs  2 (10.0%)');
    expect(text).toContain('degraded     5.0%');
  });

  it('renders the spirit metric as a share of pack items per method', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write);

    const text = lines.join('\n');
    // 30 of 50 total items served came through the vector method.
    expect(text).toMatch(/vector\s+30\s+60\.0%/);
    expect(text).toMatch(/activation\s+8\s+16\.0%/);
  });

  it('lists a method with no pack items as zero rather than dropping its row', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write);

    const text = lines.join('\n');
    // entity_resolution and recency are zero in the fixture; the row must still print so a
    // method contributing nothing is a visible reading, not a silently missing line.
    expect(text).toMatch(/entity_resolution\s+0\s+0\.0%/);
    expect(text).toMatch(/recency\s+0\s+0\.0%/);
  });

  it('renders one maintenance line per registered operation, with the last outcome', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write, NOW);

    const text = lines.join('\n');
    expect(text).toContain('cycle 41, 2 operations registered');
    expect(text).toMatch(
      /vector_backfill\s+runs 3\s+improved 2\s+unchanged 1\s+failed 0\s+last 4m ago applied \(18 affected\)/,
    );
  });

  it('separates an operation that has never been selected from one that ran and changed nothing', () => {
    const { lines, write } = collector();

    renderStats(SNAPSHOT, write, NOW);

    const text = lines.join('\n');
    expect(text).toMatch(/dead_letter\s+never selected/);
  });

  it('says counts are unavailable when Neo4j is down, without dividing by zero on cadence', () => {
    const { lines, write } = collector();
    const down: StatsSnapshot = {
      ...SNAPSHOT,
      neo4jReachable: false,
      labelCounts: new Map(),
      graph: undefined,
      edgeWeights: undefined,
      cadence: { totalCalls: 0, emptyPacks: 0 },
      sessionsServed: 0,
      degradedRate: undefined,
    };

    renderStats(down, write);

    const text = lines.join('\n');
    expect(text).toContain('counts unavailable while Neo4j is down');
    expect(text).toContain('weights    unavailable while Neo4j is down');
    expect(text).toContain('calls        0 across 0 sessions');
    expect(text).toContain('empty packs  0');
    expect(text).toContain('degraded     no recalls measured yet');
  });
});
