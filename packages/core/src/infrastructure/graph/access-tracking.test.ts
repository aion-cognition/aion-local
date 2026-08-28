import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { ACCESS_COUNT_PROPERTY, buildRecordAccessStatement, recordAccess } from './access-tracking.js';
import { BASE_NODE_LABEL } from './labels.js';
import { LAST_ACCESSED_PROPERTY } from './seed-queries.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

describe('buildRecordAccessStatement', () => {
  it('unwinds the batch and matches through the base label', () => {
    const statement = buildRecordAccessStatement({ ids: ['a', 'b'], now: NOW });
    expect(statement.cypher).toContain('UNWIND $ids AS nodeId');
    expect(statement.cypher).toContain(`MATCH (n:${BASE_NODE_LABEL} { id: nodeId })`);
  });

  it('sets last_accessed and increments access_count in the same statement', () => {
    const statement = buildRecordAccessStatement({ ids: ['a'], now: NOW });
    expect(statement.cypher).toContain(`n.${LAST_ACCESSED_PROPERTY} = $now`);
    expect(statement.cypher).toContain(
      `n.${ACCESS_COUNT_PROPERTY} = coalesce(n.${ACCESS_COUNT_PROPERTY}, 0) + 1`,
    );
  });

  it('dedupes ids and sends the timestamp as the driver-native DateTime', () => {
    const statement = buildRecordAccessStatement({ ids: ['a', 'b', 'a'], now: NOW });
    expect(statement.parameters.ids).toEqual(['a', 'b']);
    expect(neo4j.isDateTime(statement.parameters.now)).toBe(true);
  });
});

describe('recordAccess', () => {
  function fakeDriver(handler: (cypher: string, parameters: Record<string, unknown>) => unknown): Driver {
    return { executeQuery: (cypher: string, parameters: Record<string, unknown>) =>
      Promise.resolve(handler(cypher, parameters)) } as unknown as Driver;
  }

  it('sends nothing to the server for an empty batch', async () => {
    const driver = fakeDriver(() => {
      throw new Error('recordAccess queried an empty batch');
    });
    await expect(recordAccess(driver, { ids: [], now: NOW })).resolves.toBe(0);
  });

  it('writes the whole batch in one round trip and reports properties set', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const driver = fakeDriver((_cypher, parameters) => {
      calls.push(parameters);
      return {
        records: [],
        summary: { counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 4 }) } },
      };
    });

    const propertiesSet = await recordAccess(driver, { ids: ['a', 'b'], now: NOW });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(['a', 'b']);
    expect(propertiesSet).toBe(4);
  });
});
