import { DEFAULTS, type Config, type PlasticityCounters, type QueueLagSnapshot } from '@aion/core';
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
  cueDegradedRate: undefined,
  supersessionProposalsOpen: 0,
  entityMergeProposalsOpen: 0,
};

const EMPTY_PLASTICITY: PlasticityCounters = {
  reinforcement: { signalsApplied: 0, pairsApplied: 0, edgesUpdated: 0 },
  reinforcementDropped: 0,
  reinforcementQueueDepth: 0,
  decay: { edgesScanned: 0, edgesDecayed: 0 },
};

const healthy: StatusSnapshot = {
  neo4j: { uri: 'bolt://neo4j:7687', reachable: true, detail: 'Neo4j/2026.07.1' },
  ollama: {
    url: 'http://host.docker.internal:11434',
    reachable: true,
    models: ['nomic-embed-text:latest', 'qwen3:1.7b'],
  },
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
      ollama: {
        url: 'http://127.0.0.1:11434',
        reachable: false,
        models: [],
        detail: 'OllamaUnreachableError: no',
      },
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
        cueDegradedRate: undefined,
        supersessionProposalsOpen: 0,
        entityMergeProposalsOpen: 0,
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
    expect(text).toContain(
      'hebbian  reinforce 0 signals / 0 pairs / 0 edges (last run never run), queue depth 0',
    );
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

  it('reports the resolved route and what Ollama is holding in memory', () => {
    const { lines, write } = collector();
    const snapshot: StatusSnapshot = { ...healthy, resident: ['qwen3:1.7b'] };

    renderStatus(snapshot, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain(
      `routing  cue=ollama:${DEFAULTS.models.cue} reflect=ollama:${DEFAULTS.models.reflect}`,
    );
    expect(text).toContain('resident   qwen3:1.7b');
    // Nothing leaves a fully local install, so there is no banner to read past.
    expect(text).not.toContain('Anthropic API');
  });

  it('says nothing is loaded rather than leaving the resident line blank', () => {
    const { lines, write } = collector();

    renderStatus({ ...healthy, resident: [] }, DEFAULTS, write);

    expect(lines.join('\n')).toContain('resident   nothing loaded in memory');
  });

  it('names the call classes that leave the machine once the key is set', () => {
    const { lines, write } = collector();
    const keyed: Config = {
      ...DEFAULTS,
      anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-ant-test' },
    };

    renderStatus(healthy, keyed, write);

    const text = lines.join('\n');
    expect(text).toContain(`routing  cue=anthropic:${DEFAULTS.anthropic.model}`);
    expect(text).toContain('generation leaves this machine for the Anthropic API');
    expect(text).toContain('recall cue extraction');
    expect(text).toContain('embeddings and every graph read stay local');
    // The key itself is never rendered.
    expect(text).not.toContain('sk-ant-test');
  });

  it('says so when a role is pinned to a provider no key backs', () => {
    const { lines, write } = collector();
    const pinned: Config = { ...DEFAULTS, routing: { cue: 'auto', reflect: 'anthropic' } };

    renderStatus(healthy, pinned, write);

    expect(lines.join('\n')).toContain('reflect is pinned to anthropic with no key set');
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
    expect(text).toContain(
      'weights  SIMILAR p50=0.50 (min=0.20 max=0.80, n=4), CO_OCCURS n=0, RELATED_TO n=0',
    );
  });

  it('prints every lane at the mode the shipped defaults leave it in', () => {
    const { lines, write } = collector();

    renderStatus(healthy, DEFAULTS, write);

    const text = lines.join('\n');
    expect(text).toContain('lanes');
    expect(text).toContain('merge_auto          MODE: acting');
    expect(text).toContain(
      `entity_dedup        MODE: acting (${DEFAULTS.reflection.entityMergeMode})`,
    );
    expect(text).toContain(
      `supersession        MODE: acting (${DEFAULTS.reflection.supersedeMode})`,
    );
    expect(text).toContain(
      `keyed_close         MODE: acting (${DEFAULTS.reflection.keyedCloseMode})`,
    );
    expect(text).toContain('proposal_resolution MODE: acting');
    expect(text).toContain('proposal_hygiene    MODE: acting');
    expect(text).toContain('claim_dedup         MODE: acting');
    // tier3Mode ships `propose`: the advisor runs, but an accepted recommendation runs nothing.
    expect(text).toContain('tier3               MODE: off');
  });

  it('reads off, not the mode name, for supersession under propose', () => {
    const { lines, write } = collector();
    const proposeOnly: Config = {
      ...DEFAULTS,
      reflection: { ...DEFAULTS.reflection, supersedeMode: 'propose' },
    };

    renderStatus(healthy, proposeOnly, write);

    expect(lines.join('\n')).toContain('supersession        MODE: off');
  });

  it('reads off, not the mode name, for keyed_close under its own kill switch', () => {
    const { lines, write } = collector();
    const killed: Config = {
      ...DEFAULTS,
      reflection: { ...DEFAULTS.reflection, keyedCloseMode: 'off' },
    };

    renderStatus(healthy, killed, write);

    const text = lines.join('\n');
    expect(text).toContain('keyed_close         MODE: off');
    // Independent switch: killing it does not touch the other autonomous lanes.
    expect(text).toContain(
      `supersession        MODE: acting (${DEFAULTS.reflection.supersedeMode})`,
    );
  });

  it('reads off for the cascade judge tier under propose, with merge_auto still acting', () => {
    const { lines, write } = collector();
    const proposeOnly: Config = {
      ...DEFAULTS,
      reflection: { ...DEFAULTS.reflection, entityMergeMode: 'propose' },
    };

    renderStatus(healthy, proposeOnly, write);

    const text = lines.join('\n');
    expect(text).toContain('entity_dedup        MODE: off');
    // The deterministic tier is a separate switch and the mode over judgments does not reach it.
    expect(text).toContain('merge_auto          MODE: acting');
  });

  it('reads acting for tier3 only when the kill switch and the mode knob both agree', () => {
    const { lines, write } = collector();
    const acting: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, tier3: true, tier3Mode: 'act' },
    };

    renderStatus(healthy, acting, write);

    expect(lines.join('\n')).toContain('tier3               MODE: acting');
  });

  it('reads off for tier3 when the kill switch is off, whatever the mode knob says', () => {
    const { lines, write } = collector();
    const killed: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, tier3: false, tier3Mode: 'act' },
    };

    renderStatus(healthy, killed, write);

    expect(lines.join('\n')).toContain('tier3               MODE: off');
  });

  it('reads off for merge_auto and proposal_hygiene with their knobs off', () => {
    const { lines, write } = collector();
    const off: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, autoMerge: false, proposalHygiene: false },
    };

    renderStatus(healthy, off, write);

    const text = lines.join('\n');
    expect(text).toContain('merge_auto          MODE: off');
    expect(text).toContain('proposal_hygiene    MODE: off');
  });

  it('reads off for proposal_resolution under its own kill switch, hygiene untouched', () => {
    const { lines, write } = collector();
    const killed: Config = {
      ...DEFAULTS,
      maintenance: { ...DEFAULTS.maintenance, proposalResolution: false },
    };

    renderStatus(healthy, killed, write);

    const text = lines.join('\n');
    expect(text).toContain('proposal_resolution MODE: off');
    // The backstop is a switch of its own: stopping the resolver leaves it ageing rows out.
    expect(text).toContain('proposal_hygiene    MODE: acting');
  });
});
