import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContextVectorStage } from './context-vectors.js';
import { CONTEXT_VECTOR_PROPERTY } from '../../../infrastructure/graph/context-vector-queries.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';

/**
 * Exercises the stage's control flow against a minimal stand-in for the driver, dispatched
 * by which of this module's three query shapes a statement matches. `FakeGraph` (reflection's
 * shared fixture) does not model these queries and belongs to other stages' tests, so this
 * stub is local and disposable. The real Cypher is proven against a live Neo4j in
 * `context-vectors.int.test.ts`.
 */
type QueryHandler = (cypher: string, parameters: Record<string, unknown>) => Row[];

function stubDriver(handler: QueryHandler): Driver {
  const executeQuery = async (
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> => ({
    records: handler(cypher, parameters).map((row) => ({ toObject: () => row })),
    summary: {
      counters: { updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 }) },
    },
  });
  return { executeQuery } as unknown as Driver;
}

function isAffectedIdsQuery(cypher: string): boolean {
  return cypher.includes('UNION') && cypher.includes('MATCH (n:Episode { id: $episodeId })');
}

function isNeighborQuery(cypher: string): boolean {
  return cypher.includes('UNWIND $nodeIds AS nodeId');
}

function isWriteQuery(cypher: string): boolean {
  return cypher.includes(`SET n.${CONTEXT_VECTOR_PROPERTY}`);
}

const EPISODE_ID = 'episode-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');

let dataDir: string;
let logger: Logger;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-context-vector-stage-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function buildContext(driver: Driver): StageContext {
  return {
    driver,
    db: undefined as unknown as SqliteHandle,
    provider: undefined as unknown as Provider,
    episodeId: EPISODE_ID,
    episode: {
      id: EPISODE_ID,
      sessionId: 'session-1',
      text: 'irrelevant to this stage',
      turns: [],
    },
    logger,
    now: NOW,
  };
}

describe('ContextVectorStage', () => {
  it('skips cleanly when the episode touched no affected memory node', async () => {
    let neighborQueryIssued = false;
    const driver = stubDriver((cypher) => {
      if (isAffectedIdsQuery(cypher)) {
        return [];
      }
      if (isNeighborQuery(cypher)) {
        neighborQueryIssued = true;
      }
      return [];
    });

    const outcome = await new ContextVectorStage().run(buildContext(driver));

    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'no affected memory nodes to recompute',
    });
    expect(neighborQueryIssued).toBe(false);
  });

  it('skips cleanly when no affected node has a vectored neighbor', async () => {
    let writeQueryIssued = false;
    const driver = stubDriver((cypher) => {
      if (isAffectedIdsQuery(cypher)) {
        return [{ id: EPISODE_ID }];
      }
      if (isNeighborQuery(cypher)) {
        return [];
      }
      if (isWriteQuery(cypher)) {
        writeQueryIssued = true;
      }
      return [];
    });

    const outcome = await new ContextVectorStage().run(buildContext(driver));

    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'no affected node has a vectored neighbor',
    });
    expect(writeQueryIssued).toBe(false);
  });

  it('computes the weighted mean per affected node and writes it in one batch', async () => {
    const written: { id: string; vector: number[] }[] = [];
    const driver = stubDriver((cypher, parameters) => {
      if (isAffectedIdsQuery(cypher)) {
        return [{ id: EPISODE_ID }, { id: 'entity-a' }];
      }
      if (isNeighborQuery(cypher)) {
        return [
          { nodeId: EPISODE_ID, neighborId: 'entity-a', strength: 1, vector: [1, 0] },
          { nodeId: EPISODE_ID, neighborId: 'entity-b', strength: 1, vector: [0, 1] },
          // entity-a has no vectored neighbor of its own: it must not appear in the write.
        ];
      }
      if (isWriteQuery(cypher)) {
        const entries = parameters.entries as { id: string; vector: number[] }[];
        written.push(...entries);
        return entries.map((entry) => ({ id: entry.id }));
      }
      throw new Error(`unexpected statement:\n${cypher}`);
    });

    const outcome = await new ContextVectorStage().run(buildContext(driver));

    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toBe(`recomputed context_vec for 1 of 2 affected node(s)`);
    expect(outcome.counts).toEqual({ contextVectors: 1 });
    expect(written).toHaveLength(1);
    expect(written[0]?.id).toBe(EPISODE_ID);
    expect(written[0]?.vector[0]).toBeCloseTo(0.5, 5);
    expect(written[0]?.vector[1]).toBeCloseTo(0.5, 5);
  });

  it('returns a failed outcome without throwing when the graph read fails', async () => {
    const driver = stubDriver(() => {
      throw new Error('neo4j unreachable');
    });

    const outcome = await new ContextVectorStage().run(buildContext(driver));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('neo4j unreachable');
  });

  it('returns a failed outcome without throwing when the batched write fails', async () => {
    const driver = stubDriver((cypher) => {
      if (isAffectedIdsQuery(cypher)) {
        return [{ id: EPISODE_ID }];
      }
      if (isNeighborQuery(cypher)) {
        return [{ nodeId: EPISODE_ID, neighborId: 'entity-a', strength: 1, vector: [1, 0] }];
      }
      throw new Error('write rejected');
    });

    const outcome = await new ContextVectorStage().run(buildContext(driver));

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('write rejected');
  });
});
