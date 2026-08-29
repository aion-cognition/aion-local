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
    reinforcement: { signalsApplied: 10, pairsApplied: 4, edgesUpdated: 4, lastRunAt: '2026-08-27T00:00:00.000Z' },
    reinforcementDropped: 0,
    reinforcementQueueDepth: 2,
    decay: { edgesScanned: 20, edgesDecayed: 3, lastRunAt: '2026-08-27T00:00:00.000Z' },
  },
  edgeWeights: {
    CO_OCCURS: { p50: 0.4, min: 0.1, max: 0.9, count: 5 },
  },
  cadence: { totalCalls: 20, emptyPacks: 2 },
  sessionsServed: 4,
  degradedRate: 0.05,
  methodCounters: {
    vector: 30,
    bm25: 10,
    graph_traversal: 0,
    activation: 8,
    resonance: 2,
    entity_resolution: 0,
    recency: 0,
  },
};

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
