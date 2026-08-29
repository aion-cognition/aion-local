import { DEFAULTS, type QueueLagSnapshot } from '@aion/core';
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

const healthy: StatusSnapshot = {
  neo4j: { uri: 'bolt://neo4j:7687', reachable: true, detail: 'Neo4j/2026.07.1' },
  ollama: { url: 'http://host.docker.internal:11434', reachable: true, models: ['nomic-embed-text:latest', 'qwen3:1.7b'] },
  graph: { nodes: 2, relationships: 0 },
  queue: EMPTY_QUEUE,
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
    };

    renderStatus(down, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('neo4j    down');
    expect(text).toContain('connection refused');
    expect(text).toContain('graph    counts unavailable while Neo4j is down');
    expect(text).not.toContain('0 nodes');
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
});
