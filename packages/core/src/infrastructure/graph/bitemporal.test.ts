import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { BITEMPORAL_PROPERTIES, buildStampedNodeWrite, stampNew } from './bitemporal.js';
import { BASE_NODE_LABEL, isContentBearing, NODE_LABELS, resolveLabels } from './labels.js';
import { fromGraphDateTime } from './values.js';

const NOW = new Date('2026-02-03T04:05:06.000Z');
const OCCURRED = new Date('2026-01-01T00:00:00.000Z');

describe('stampNew', () => {
  it('stamps both timelines and leaves each end open', () => {
    const stamped = stampNew({ label: 'Episode', now: NOW, occurredAt: OCCURRED });
    expect(stamped.properties[BITEMPORAL_PROPERTIES.occurredAt]).toBe(OCCURRED);
    expect(stamped.properties[BITEMPORAL_PROPERTIES.validFrom]).toBe(OCCURRED);
    expect(stamped.properties[BITEMPORAL_PROPERTIES.txFrom]).toBe(NOW);
    expect(stamped.properties).not.toHaveProperty(BITEMPORAL_PROPERTIES.validUntil);
    expect(stamped.properties).not.toHaveProperty(BITEMPORAL_PROPERTIES.txUntil);
    expect(stamped.properties).not.toHaveProperty(BITEMPORAL_PROPERTIES.forgottenAt);
  });

  it('defaults occurred_at to the write clock and valid_from to occurred_at', () => {
    const stamped = stampNew({ label: 'Turn', now: NOW });
    expect(stamped.properties[BITEMPORAL_PROPERTIES.occurredAt]).toBe(NOW);
    expect(stamped.properties[BITEMPORAL_PROPERTIES.validFrom]).toBe(NOW);
  });

  it('accepts a valid_from distinct from occurred_at', () => {
    const validFrom = new Date('2026-01-15T00:00:00.000Z');
    const stamped = stampNew({ label: 'Episode', now: NOW, occurredAt: OCCURRED, validFrom });
    expect(stamped.properties[BITEMPORAL_PROPERTIES.validFrom]).toBe(validFrom);
    expect(stamped.properties[BITEMPORAL_PROPERTIES.occurredAt]).toBe(OCCURRED);
  });

  it('carries one id into both the result and the property bag', () => {
    const generated = stampNew({ label: 'Episode' });
    expect(generated.properties.id).toBe(generated.id);
    expect(stampNew({ label: 'Episode', id: 'fixed' }).properties.id).toBe('fixed');
  });

  it('keeps caller properties and never lets them shadow the stamp', () => {
    const stamped = stampNew({
      label: 'Episode',
      now: NOW,
      properties: { summary: 'a day', [BITEMPORAL_PROPERTIES.txFrom]: new Date(0) },
    });
    expect(stamped.properties.summary).toBe('a day');
    expect(stamped.properties[BITEMPORAL_PROPERTIES.txFrom]).toBe(NOW);
  });
});

describe('labels', () => {
  it('gives content-bearing nodes the shared Memory label', () => {
    expect(resolveLabels('Episode')).toEqual(['Episode', 'Memory', BASE_NODE_LABEL]);
    expect(resolveLabels('Turn')).toEqual(['Turn', 'Memory', BASE_NODE_LABEL]);
    expect(isContentBearing('Episode')).toBe(true);
    expect(isContentBearing('Session')).toBe(false);
  });

  it('gives backbone nodes the Entity label the composite constraint needs', () => {
    expect(resolveLabels('Member')).toEqual(['Member', 'Entity', BASE_NODE_LABEL]);
    expect(resolveLabels('Workspace')).toEqual(['Workspace', 'Entity', BASE_NODE_LABEL]);
  });

  it('lists the primary label first for every known label', () => {
    for (const label of NODE_LABELS) {
      expect(resolveLabels(label)[0]).toBe(label);
    }
  });

  it('gives every node the base label, so an id lookup has an index to seek', () => {
    for (const label of NODE_LABELS) {
      expect(resolveLabels(label)).toContain(BASE_NODE_LABEL);
    }
  });
});

describe('buildStampedNodeWrite', () => {
  it('merges on the primary label and id and applies companions on both branches', () => {
    const { cypher } = buildStampedNodeWrite({ label: 'Episode', id: 'e1', now: NOW });
    expect(cypher).toContain('MERGE (n:Episode { id: $id })');
    expect(cypher).toContain(`ON CREATE SET n:Memory:${BASE_NODE_LABEL}, n += $properties`);
    expect(cypher).toContain(`ON MATCH SET n:Memory:${BASE_NODE_LABEL}`);
  });

  it('writes no stamp on match, so a repeat write cannot move history', () => {
    const { cypher } = buildStampedNodeWrite({ label: 'Episode', id: 'e1', now: NOW });
    const onMatch = cypher.slice(cypher.indexOf('ON MATCH SET'));
    expect(onMatch).not.toContain('$properties');
    expect(onMatch).not.toContain(BITEMPORAL_PROPERTIES.txFrom);
  });

  it('applies the base label on both branches even where there is nothing else to set', () => {
    const { cypher } = buildStampedNodeWrite({ label: 'Session', id: 's1', now: NOW });
    expect(cypher).toContain(`ON MATCH SET n:${BASE_NODE_LABEL}`);
    expect(cypher.slice(cypher.indexOf('ON MATCH SET'))).not.toContain('$properties');
  });

  it('applies merge properties on both branches for the structural upgrade path', () => {
    const built = buildStampedNodeWrite({
      label: 'Member',
      id: 'm1',
      now: NOW,
      mergeProperties: { is_structural: true },
    });
    expect(built.cypher).toContain(
      `ON CREATE SET n:Entity:${BASE_NODE_LABEL}, n += $properties, n += $mergeProperties`,
    );
    expect(built.cypher).toContain(
      `ON MATCH SET n:Entity:${BASE_NODE_LABEL}, n += $mergeProperties`,
    );
    expect(built.parameters.mergeProperties).toEqual({ is_structural: true });
  });

  it('converts dates to driver temporal values rather than sending a JS Date', () => {
    const built = buildStampedNodeWrite({ label: 'Episode', id: 'e1', now: NOW });
    const properties = built.parameters.properties as Record<string, unknown>;
    const txFrom = properties[BITEMPORAL_PROPERTIES.txFrom];
    expect(txFrom).not.toBeInstanceOf(Date);
    expect(neo4j.isDateTime(txFrom)).toBe(true);
    expect(fromGraphDateTime(txFrom)).toEqual(NOW);
  });
});
