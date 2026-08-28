import { DEFAULTS } from '@aion/core';
import { describe, expect, it } from 'vitest';
import { renderStatus, type StatusSnapshot } from './status.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

const healthy: StatusSnapshot = {
  neo4j: { uri: 'bolt://neo4j:7687', reachable: true, detail: 'Neo4j/2026.07.1' },
  ollama: { url: 'http://host.docker.internal:11434', reachable: true, models: ['nomic-embed-text:latest', 'qwen3:1.7b'] },
  graph: { nodes: 2, relationships: 0 },
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
    };

    renderStatus(down, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('neo4j    down');
    expect(text).toContain('connection refused');
    expect(text).toContain('graph    counts unavailable while Neo4j is down');
    expect(text).not.toContain('0 nodes');
  });
});
