import { describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES } from './bitemporal.js';
import { ensureGraphSession } from './sessions.js';
import { fromGraphDateTime } from './values.js';
import { FakeGraph } from '../../reflection/test-support/fake-graph.fixture.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');
const OCCURRED = new Date('2025-04-17T08:30:00.000Z');

function seedBackbone(graph: FakeGraph): void {
  graph.seedNode('member-1', ['Member']);
  graph.seedNode('workspace-1', ['Workspace']);
}

describe('ensureGraphSession', () => {
  it('stamps world time from the experience clock and system time from the write clock', async () => {
    const graph = new FakeGraph();
    seedBackbone(graph);

    await ensureGraphSession(graph.driver, {
      sessionId: 'session-1',
      memberId: 'member-1',
      workspaceId: 'workspace-1',
      now: NOW,
      occurredAt: OCCURRED,
    });

    const properties = graph.nodes.get('session-1')?.properties ?? {};
    expect(fromGraphDateTime(properties[BITEMPORAL_PROPERTIES.occurredAt])).toEqual(OCCURRED);
    expect(fromGraphDateTime(properties[BITEMPORAL_PROPERTIES.validFrom])).toEqual(OCCURRED);
    expect(fromGraphDateTime(properties[BITEMPORAL_PROPERTIES.txFrom])).toEqual(NOW);
  });

  it('falls back to the write clock for a caller with no experience clock to give', async () => {
    const graph = new FakeGraph();
    seedBackbone(graph);

    await ensureGraphSession(graph.driver, {
      sessionId: 'session-2',
      memberId: 'member-1',
      workspaceId: 'workspace-1',
      now: NOW,
    });

    const properties = graph.nodes.get('session-2')?.properties ?? {};
    expect(fromGraphDateTime(properties[BITEMPORAL_PROPERTIES.occurredAt])).toEqual(NOW);
    expect(fromGraphDateTime(properties[BITEMPORAL_PROPERTIES.txFrom])).toEqual(NOW);
  });
});
