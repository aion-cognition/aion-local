import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupNarratives } from './narrative-cleanup.js';
import type { NarrativeDeps } from './narratives.js';
import { BITEMPORAL_PROPERTIES } from '../../infrastructure/graph/bitemporal.js';
import { CONTAINMENT_TYPE, MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
} from '../../infrastructure/graph/narrative-queries.js';
import { coerceGraphValue } from '../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';
import { NarrativeFakeGraph } from '../test-support/narrative-graph.fixture.js';

const SESSION_ID = 'session-with-episodes';
const EMPTY_SESSION_ID = 'session-without-episodes';
const NOW = new Date('2026-04-02T12:00:00Z');

const OUTPUT = {
  sentences: [{ text: 'The orders table was left unsharded.', source_ids: ['S1'] }],
};

let graph: NarrativeFakeGraph;
let dataDir: string;
let logger: Logger;
let generate: ReturnType<typeof vi.fn>;
let deps: NarrativeDeps;

function fakeVectors(texts: readonly string[]): Vector[] {
  return texts.map(() => [1, 0, 0, 0]);
}

function seedEpisode(id: string, sessionId: string): void {
  graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.text]: `body of ${id}`,
    [MEMORY_PROPERTIES.sessionId]: sessionId,
    [BITEMPORAL_PROPERTIES.occurredAt]: new Date('2026-04-02T10:00:00Z'),
    [BITEMPORAL_PROPERTIES.txFrom]: new Date('2026-04-02T10:00:00Z'),
  });
  graph.seedEdge(CONTAINMENT_TYPE, id, sessionId);
}

/** A narrative as the free-prose writer left it: no citations, still standing. */
function seedOldNarrative(
  id: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): void {
  graph.seedNode(id, ['Narrative', 'Memory', 'AionNode'], {
    [MEMORY_PROPERTIES.summary]: 'The session focused on a close-mode probe.',
    [MEMORY_PROPERTIES.text]: 'The probe was presumably gathering detailed data from a target.',
    [NARRATIVE_PROPERTIES.version]: 1,
    [NARRATIVE_PROPERTIES.coverageKey]: 'stale-key',
    [NARRATIVE_PROPERTIES.coverageCount]: 1,
    ...extra,
  });
  graph.seedEdge(DERIVES_FROM_TYPE, id, sessionId);
}

function narrativesStanding(): { id: string; properties: Record<string, unknown> }[] {
  return graph
    .nodesWithLabel('Narrative')
    .filter((node) => node.properties[BITEMPORAL_PROPERTIES.validUntil] === undefined);
}

beforeEach(() => {
  graph = new NarrativeFakeGraph();
  graph.seedNode(SESSION_ID, ['Session', 'AionNode']);
  graph.seedNode(EMPTY_SESSION_ID, ['Session', 'AionNode']);

  dataDir = mkdtempSync(join(tmpdir(), 'aion-narrative-cleanup-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  generate = vi.fn(() => Promise.resolve(OUTPUT));
  deps = {
    driver: graph.driver,
    provider: {
      embed: vi.fn((texts: readonly string[]) => Promise.resolve(fakeVectors(texts))),
      generate,
    } as unknown as Provider,
    logger,
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('narrative cleanup', () => {
  it('regenerates the narrative of a session that still holds episodes', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report).toEqual({
      examined: 1,
      sessions: 1,
      regenerated: 1,
      forgotten: 0,
      failed: 0,
    });

    const standing = narrativesStanding();
    expect(standing).toHaveLength(1);
    expect(standing[0]?.id).not.toBe('old-narrative');
    expect(standing[0]?.properties[MEMORY_PROPERTIES.text]).toBe(
      'The orders table was left unsharded.',
    );
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.citations]).toEqual(['episode-1']);
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.grounding]).toBe(NARRATIVE_GROUNDING);
    expect(standing[0]?.properties[NARRATIVE_PROPERTIES.version]).toBe(2);
  });

  it('supersedes the old narrative rather than deleting it', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);

    await cleanupNarratives(deps, { now: NOW });

    const old = graph.nodes.get('old-narrative');
    expect(coerceGraphValue(old?.properties[BITEMPORAL_PROPERTIES.validUntil])).toEqual(NOW);
    expect(old?.properties[BITEMPORAL_PROPERTIES.forgottenAt]).toBeUndefined();
    expect(graph.edgesOfType('SUPERSEDES').map((edge) => edge.targetId)).toEqual(['old-narrative']);
  });

  it('forgets a narrative whose session can no longer ground one', async () => {
    seedOldNarrative('orphan-narrative', EMPTY_SESSION_ID);

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.forgotten).toBe(1);
    expect(report.regenerated).toBe(0);
    expect(generate).not.toHaveBeenCalled();
    const orphan = graph.nodes.get('orphan-narrative');
    expect(coerceGraphValue(orphan?.properties[BITEMPORAL_PROPERTIES.forgottenAt])).toEqual(NOW);
    expect(coerceGraphValue(orphan?.properties[BITEMPORAL_PROPERTIES.validUntil])).toEqual(NOW);
  });

  it('leaves a narrative already written under the current grounding revision alone', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('grounded-narrative', SESSION_ID, {
      [NARRATIVE_PROPERTIES.citations]: ['episode-1'],
      [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    });

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.examined).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it('converges: a second pass finds nothing left to repair', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);
    await cleanupNarratives(deps, { now: NOW });

    const second = await cleanupNarratives(deps, { now: NOW });

    expect(second.examined).toBe(0);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('counts a failed regeneration and leaves the old narrative standing', async () => {
    seedEpisode('episode-1', SESSION_ID);
    seedOldNarrative('old-narrative', SESSION_ID);
    generate.mockRejectedValueOnce(new Error('ollama is down'));

    const report = await cleanupNarratives(deps, { now: NOW });

    expect(report.failed).toBe(1);
    expect(report.regenerated).toBe(0);
    expect(narrativesStanding().map((node) => node.id)).toEqual(['old-narrative']);
  });
});
