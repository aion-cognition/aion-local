import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContextVectorStage } from './context-vectors.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import { openLogger, type Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider } from '../../../infrastructure/providers/types.js';
import type {
  PublicationCoordinator,
  PublicationRequest,
} from '../../../infrastructure/publication/coordinator.js';
import type { JsonValue, PublicationOutcome } from '../../../infrastructure/publication/types.js';
import { activateCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import type { StageContext } from '../../domain/stage.js';
import { PIPELINE_VERSION } from '../../domain/version.js';

/**
 * What the stage still decides, now that the write is a publication.
 *
 * It nominates: the episode's own family, closed over the far endpoints of the edges this run
 * wrote, deduplicated. It hands that set to `context_vector_sync` and reports what the receipt
 * says. It decides nothing about any individual node — the weighted mean is
 * `reflection/domain/context-vector.test.ts` and the per-node dispositions are the operation's,
 * proved against a real store in `reflection/application/context-vector-sync.int.test.ts`.
 *
 * So the driver stub here only answers the two READS, and the coordinator stub records the one
 * request. A statement reaching the stub driver that is not one of those two reads is the
 * failure this file is watching for: it would mean the stage had gone back to writing.
 */
type QueryHandler = (cypher: string, parameters: Record<string, unknown>) => Row[];

/** The run-start neighbourhood binding the publication takes; not a decision this stage makes. */
function isRevisionQuery(cypher: string): boolean {
  return cypher.includes('RETURN n.id AS id, degree AS degree');
}

function stubDriver(handler: QueryHandler): Driver {
  const executeQuery = async (
    cypher: string,
    parameters: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const rows = isRevisionQuery(cypher)
      ? (parameters.ids as string[]).map((id) => ({ id, degree: 1, moved: '2026-08-28T09:00:00Z' }))
      : handler(cypher, parameters);
    return {
      records: rows.map((row) => ({ toObject: () => row })),
      summary: {
        counters: {
          updates: () => ({ nodesCreated: 0, relationshipsCreated: 0, propertiesSet: 0 }),
        },
      },
    };
  };
  return { executeQuery } as unknown as Driver;
}

function isAffectedIdsQuery(cypher: string): boolean {
  return cypher.includes('UNION') && cypher.includes('MATCH (n:Episode { id: $episodeId })');
}

/** Shares the `UNWIND $nodeIds` opener with the neighbor read, so it is matched on its return. */
function isClosureQuery(cypher: string): boolean {
  return cypher.includes('RETURN DISTINCT m.id AS id');
}

const EPISODE_ID = 'episode-1';
const NOW = new Date('2026-08-28T09:05:00.000Z');

/** Every request the stage made, so a case can assert both what was published and that one was. */
type Published = PublicationRequest[];

/**
 * The coordinator as the stage uses it: one `publish`, one answer. Cast rather than built,
 * because a real one wants a driver, a store and an initialized receipt, and what this file
 * asks of it is which nodes it was handed.
 */
function stubPublications(
  captured: Published,
  answer: (request: PublicationRequest) => PublicationOutcome,
): PublicationCoordinator {
  return {
    publish: (request: PublicationRequest): Promise<PublicationOutcome> => {
      captured.push(request);
      return Promise.resolve(answer(request));
    },
  } as unknown as PublicationCoordinator;
}

function acknowledged(result: JsonValue): PublicationOutcome {
  return {
    status: 'acknowledged',
    operationId: 'op-1',
    sequence: '1',
    result,
    knownFrom: NOW.toISOString(),
    observedAckAt: NOW.toISOString(),
    clockClamped: false,
  };
}

function nodesOf(captured: Published): string[] {
  const payload = captured[0]?.payload as { nodes?: { id: string }[] } | undefined;
  return (payload?.nodes ?? []).map((node) => node.id);
}

let dataDir: string;
let logger: Logger;
let store: SqliteStore;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-context-vector-stage-'));
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  // A real store rather than a stand-in: the publication binds the coverage epoch at run start,
  // and a faked read of it would prove the binding against a value this file chose.
  store = new SqliteStore({ filePath: join(dataDir, 'aion.sqlite') });
  activateCoverageContract(store.db, { activatedAt: NOW, fieldPolicyVersion: 1 });
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function buildContext(driver: Driver, publications?: PublicationCoordinator): StageContext {
  return {
    driver,
    db: store.db,
    provider: undefined as unknown as Provider,
    ...(publications === undefined ? {} : { publications }),
    episodeId: EPISODE_ID,
    episode: {
      id: EPISODE_ID,
      sessionId: 'session-1',
      text: 'irrelevant to this stage',
      turns: [],
    },
    logger,
    now: NOW,
    occurredAt: NOW,
    pipelineVersion: PIPELINE_VERSION,
  };
}

describe('ContextVectorStage', () => {
  it('refuses before it reads anything when no coordinator is composed', async () => {
    let queried = false;
    const driver = stubDriver(() => {
      queried = true;
      return [];
    });

    const outcome = await new ContextVectorStage().run(buildContext(driver));

    expect(outcome).toEqual({
      status: 'failed',
      summary: 'context vector recomputation is not composed: no publication coordinator',
    });
    // The property cannot be written at all without the guard, so a pipeline missing it says so
    // rather than spending two reads to arrive at the same refusal.
    expect(queried).toBe(false);
  });

  it('skips cleanly when the episode touched no affected memory node', async () => {
    const captured: Published = [];
    const driver = stubDriver((cypher) => {
      if (isAffectedIdsQuery(cypher)) {
        return [];
      }
      throw new Error(`unexpected statement:\n${cypher}`);
    });

    const outcome = await new ContextVectorStage().run(
      buildContext(
        driver,
        stubPublications(captured, () => acknowledged(null)),
      ),
    );

    expect(outcome).toEqual({
      status: 'skipped',
      summary: 'no affected memory nodes to recompute',
      retryable: true,
      settledOnUpstream: {
        disposition: 'not_applicable',
        reason: 'proved_empty_input',
        proof: { affectedNodes: 0 },
      },
    });
    expect(captured).toEqual([]);
  });

  it('nominates exactly the family it read and publishes it once', async () => {
    const captured: Published = [];
    const driver = stubDriver((cypher) => {
      if (isAffectedIdsQuery(cypher)) {
        return [{ id: EPISODE_ID }, { id: 'entity-a' }];
      }
      if (isClosureQuery(cypher)) {
        return [];
      }
      throw new Error(`unexpected statement:\n${cypher}`);
    });

    const outcome = await new ContextVectorStage().run(
      buildContext(
        driver,
        stubPublications(captured, () =>
          acknowledged({
            recomputed: [EPISODE_ID],
            cleared: [],
            stamped: [],
            holds: [{ id: 'entity-a', reason: 'neighbor_vector_pending' }],
          }),
        ),
      ),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.kind).toBe('context_vector_sync');
    // Sorted, not in read order: the intent's own discipline, so one population always
    // produces one digest whichever read found which member first.
    expect(nodesOf(captured)).toEqual(['entity-a', EPISODE_ID]);
    expect(outcome.status).toBe('ok');
    // Reported from the receipt, not from the nomination: the stage nominated two and the
    // operation wrote one, and a summary counted off the nomination would claim both.
    expect(outcome.summary).toBe(
      'recomputed context_vec for 1 of 2 affected node(s), 0 cleared, 0 unweighted, 1 held',
    );
    expect(outcome.counts).toEqual({ contextVectors: 1 });
  });

  it('folds the far endpoints of the edges this run wrote into the set it nominates', async () => {
    const captured: Published = [];
    let closureAnchors: readonly string[] = [];
    const driver = stubDriver((cypher, parameters) => {
      if (isAffectedIdsQuery(cypher)) {
        return [{ id: EPISODE_ID }];
      }
      if (isClosureQuery(cypher)) {
        closureAnchors = parameters.nodeIds as string[];
        // The episode's own id comes back with it: most edges a run writes land inside the
        // family, and the stage is what deduplicates the two sets.
        return [{ id: EPISODE_ID }, { id: 'entity-far' }];
      }
      throw new Error(`unexpected statement:\n${cypher}`);
    });

    const outcome = await new ContextVectorStage().run(
      buildContext(
        driver,
        stubPublications(captured, () =>
          acknowledged({
            recomputed: [EPISODE_ID, 'entity-far'],
            cleared: [],
            stamped: [],
            holds: [],
          }),
        ),
      ),
    );

    expect(closureAnchors).toEqual([EPISODE_ID]);
    expect(nodesOf(captured)).toEqual(['entity-far', EPISODE_ID]);
    expect(outcome.counts).toEqual({ contextVectors: 2 });
  });

  it('returns a failed outcome without throwing when the graph read fails', async () => {
    const captured: Published = [];
    const driver = stubDriver(() => {
      throw new Error('neo4j unreachable');
    });

    const outcome = await new ContextVectorStage().run(
      buildContext(
        driver,
        stubPublications(captured, () => acknowledged(null)),
      ),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toContain('neo4j unreachable');
    expect(captured).toEqual([]);
  });

  it('reports the guard’s refusal rather than a recomputation it did not get', async () => {
    const captured: Published = [];
    const driver = stubDriver((cypher) => {
      if (isAffectedIdsQuery(cypher)) {
        return [{ id: EPISODE_ID }];
      }
      if (isClosureQuery(cypher)) {
        return [];
      }
      throw new Error(`unexpected statement:\n${cypher}`);
    });

    const outcome = await new ContextVectorStage().run(
      buildContext(
        driver,
        stubPublications(captured, (request) => ({
          status: 'deferred',
          operationId: request.operationId,
          sequence: '1',
          reason: 'every_binding_moved',
        })),
      ),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toBe('context vector recomputation was refused: every_binding_moved');
    expect(outcome.counts).toBeUndefined();
  });
});
