import { DEFAULTS, type PlasticityCounters, type QueueLagSnapshot } from '@aion/core';
import { describe, expect, it } from 'vitest';
import { renderStatus, type StatusSnapshot } from './status.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const EMPTY_QUEUE: QueueLagSnapshot = {
  depthByLane: { interactive: 0, bulk: 0 },
  oldestUnclaimedMs: undefined,
  exhausted: 0,
  reinforcementDropped: 0,
  p95EnrichmentLagMs: undefined,
};

const EMPTY_PLASTICITY: PlasticityCounters = {
  reinforcement: { signalsApplied: 0, pairsApplied: 0, edgesUpdated: 0 },
  reinforcementDropped: 0,
  reinforcementQueueDepth: 0,
  decay: { edgesScanned: 0, edgesDecayed: 0 },
};

const healthy: StatusSnapshot = {
  neo4j: { uri: 'bolt://neo4j:7687', reachable: true, detail: 'Neo4j/2026.07.1' },
  ollama: { url: 'http://host.docker.internal:11434', reachable: true, models: ['nomic-embed-text:latest', 'qwen3:1.7b'] },
  graph: { nodes: 2, relationships: 0 },
  queue: EMPTY_QUEUE,
  plasticity: EMPTY_PLASTICITY,
  edgeWeights: { SIMILAR: undefined, CO_OCCURS: undefined, RELATED_TO: undefined },
};

describe('renderStatus', () => {
  it('reports both services, the configured models, and the graph counts', () => {
    const { lines, write } = collector();

    renderStatus(healthy, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('neo4j    up  bolt://neo4j:7687');
    expect(text).toContain('ollama   up  http://host.docker.internal:11434');
    expect(text).toContain(`embed=${DEFAULTS.models.embed}`);
    expect(text).toContain('nomic-embed-text:latest, qwen3:1.7b');
    expect(text).toContain('graph    2 nodes, 0 relationships');
  });

  it('says counts are unavailable rather than reporting zero when Neo4j is down', () => {
    const { lines, write } = collector();
    const down: StatusSnapshot = {
      neo4j: { uri: 'bolt://neo4j:7687', reachable: false, detail: 'connection refused' },
      ollama: { url: 'http://127.0.0.1:11434', reachable: false, models: [], detail: 'OllamaUnreachableError: no' },
      queue: EMPTY_QUEUE,
      plasticity: EMPTY_PLASTICITY,
    };

    renderStatus(down, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('neo4j    down');
    expect(text).toContain('connection refused');
    expect(text).toContain('graph    counts unavailable while Neo4j is down');
    expect(text).not.toContain('0 nodes');
    expect(text).toContain('weights  unavailable while Neo4j is down');
  });

  it('reports queue depth by lane, oldest-unclaimed age, exhausted, and p95 lag', () => {
    const { lines, write } = collector();
    const snapshot: StatusSnapshot = {
      ...healthy,
      queue: {
        depthByLane: { interactive: 2, bulk: 5 },
        oldestUnclaimedMs: 130_000,
        exhausted: 1,
        reinforcementDropped: 7,
        p95EnrichmentLagMs: 42_000,
      },
    };

    renderStatus(snapshot, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('queue    interactive=2 bulk=5, oldest unclaimed 2m, 1 exhausted');
    expect(text).toContain('lag      p95 intake-to-enriched 42s, 7 reinforcement rows dropped');
  });

  it('says none unclaimed and no samples yet rather than a misleading zero', () => {
    const { lines, write } = collector();

    renderStatus(healthy, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('oldest unclaimed none unclaimed');
    expect(text).toContain('p95 intake-to-enriched no samples yet');
  });

  it('reports never run rather than a blank timestamp before either operation has run', () => {
    const { lines, write } = collector();

    renderStatus(healthy, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('hebbian  reinforce 0 signals / 0 pairs / 0 edges (last run never run), queue depth 0');
    expect(text).toContain('decay    0 scanned / 0 decayed (last run never run)');
  });

  it('reports what reinforcement and decay have done, and the live queue depth', () => {
    const { lines, write } = collector();
    const snapshot: StatusSnapshot = {
      ...healthy,
      plasticity: {
        reinforcement: {
          signalsApplied: 12,
          pairsApplied: 5,
          edgesUpdated: 4,
          lastRunAt: '2026-08-27T00:00:00.000Z',
        },
        reinforcementDropped: 0,
        reinforcementQueueDepth: 3,
        decay: { edgesScanned: 9, edgesDecayed: 6, lastRunAt: '2026-08-27T00:05:00.000Z' },
      },
    };

    renderStatus(snapshot, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain(
      'hebbian  reinforce 12 signals / 5 pairs / 4 edges (last run 2026-08-27T00:00:00.000Z), queue depth 3',
    );
    expect(text).toContain('decay    9 scanned / 6 decayed (last run 2026-08-27T00:05:00.000Z)');
  });

  it('reports the edge-weight distribution per type, and n=0 for a type with no live edge', () => {
    const { lines, write } = collector();
    const snapshot: StatusSnapshot = {
      ...healthy,
      edgeWeights: {
        SIMILAR: { count: 4, min: 0.2, p10: 0.25, p50: 0.5, p90: 0.75, max: 0.8 },
        CO_OCCURS: undefined,
        RELATED_TO: undefined,
      },
    };

    renderStatus(snapshot, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('weights  SIMILAR p50=0.50 (min=0.20 max=0.80, n=4), CO_OCCURS n=0, RELATED_TO n=0');
  });
});
