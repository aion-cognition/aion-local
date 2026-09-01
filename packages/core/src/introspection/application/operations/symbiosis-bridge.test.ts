import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import { symbiosisBridgeOperation } from './symbiosis-bridge.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import type { Row } from '../../../infrastructure/graph/values.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { Provider, StructuredRequest } from '../../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';
import type { OperationContext } from '../../domain/operation.js';
import { healthFixture } from '../../domain/test-support/health.fixture.js';

/**
 * What the bridge write puts in a live graph belongs in `community-bridge.int.test.ts`. What
 * is provable here is the shutdown path: the run holds one model call, and the service stops
 * by aborting the context signal.
 *
 * The fake recognises the exact statements this operation issues and throws on anything else,
 * the same way `fake-graph.fixture.ts` models intake's writes, so a query shape change fails
 * loudly rather than answering something the fake does not model.
 */

const STAGE_TIMEOUT_MS = 2_000;

/** Well under the timeout, and far enough above scheduling noise to mean something. */
const PROMPT_RETURN_MS = 500;

const CONFIG: Config = {
  ...DEFAULTS,
  reflection: { ...DEFAULTS.reflection, stageTimeoutMs: STAGE_TIMEOUT_MS },
};

/** Two equal, internally dense, wholly unconnected communities: the pair a bridge is for. */
const PROFILE_ROWS: Row[] = [
  { community: 1, size: 10, external_edges: 0, internal_edges: 10 },
  { community: 2, size: 10, external_edges: 0, internal_edges: 10 },
];

const CLOSEST_PAIR_ROW: Row = {
  left_id: 'left-node',
  left_label: 'the connection pool',
  right_id: 'right-node',
  right_label: 'the June incident',
  score: 0.42,
};

function silentLogger(): Logger {
  const noop = (): void => {
    // A test logger that prints nothing, on purpose.
  };
  return { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;
}

function results(rows: readonly Row[], nodesCreated = 0): unknown {
  return {
    records: rows.map((row) => ({ toObject: (): Row => row })),
    summary: {
      counters: {
        updates: () => ({ nodesCreated, relationshipsCreated: 0, propertiesSet: 0 }),
      },
    },
  };
}

function answer(cypher: string, parameters: Record<string, unknown>): unknown {
  if (cypher.includes('AS internal_edges')) {
    return results(PROFILE_ROWS);
  }
  if (cypher.includes('AS edges')) {
    return results([]);
  }
  if (cypher.includes('count(b) AS count')) {
    return results([{ count: 0 }]);
  }
  if (cypher.includes('AS left_id')) {
    return results([CLOSEST_PAIR_ROW]);
  }
  if (cypher.includes('MERGE (n:Bridge { id: $id })')) {
    return results([{ id: parameters.id, labels: ['Bridge'] }], 1);
  }
  if (cypher.includes('MERGE (a)-[r:RELATED_TO]->(b)')) {
    return results([
      {
        id: parameters.id,
        sourceId: parameters.sourceId,
        targetId: parameters.targetId,
        strength: parameters.strength,
        confidence: parameters.confidence,
        signals: parameters.signals,
        provenance: parameters.provenance,
        count: parameters.count,
        rationale: parameters.rationale,
        createdAt: parameters.now,
        updatedAt: parameters.now,
      },
    ]);
  }
  throw new Error(`the fake driver has no model for this statement:\n${cypher}`);
}

function fakeDriver(): Driver {
  const run = (cypher: string, parameters: Record<string, unknown> = {}): Promise<unknown> =>
    Promise.resolve(answer(cypher, parameters));
  return {
    executeQuery: run,
    session: () => ({
      executeWrite: (work: (tx: { run: typeof run }) => Promise<unknown>): Promise<unknown> =>
        work({ run }),
      close: (): Promise<void> => Promise.resolve(),
    }),
  } as unknown as Driver;
}

type HangingProvider = {
  readonly provider: Provider;
  /** Resolves with the request the operation handed `generate`, once the call is under way. */
  readonly started: Promise<StructuredRequest>;
};

/** Never answers on its own: the only way out is the abort the caller composed. */
function hangingProvider(): HangingProvider {
  let announce: (request: StructuredRequest) => void = () => {
    // Replaced synchronously by the promise executor below.
  };
  const started = new Promise<StructuredRequest>((resolve) => {
    announce = resolve;
  });
  const provider: Provider = {
    embed: (texts) =>
      Promise.resolve(texts.map(() => new Array(DEFAULTS.models.embedDimension).fill(0.01))),
    generate: (request: StructuredRequest): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        announce(request);
        if (request.signal?.aborted === true) {
          reject(new Error('the call was aborted'));
          return;
        }
        request.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('the call was aborted'));
          },
          { once: true },
        );
      }),
  };
  return { provider, started };
}

function contextFor(provider: Provider, signal: AbortSignal): OperationContext {
  return {
    driver: fakeDriver(),
    db: undefined as unknown as SqliteHandle,
    config: CONFIG,
    logger: silentLogger(),
    provider,
    health: healthFixture(),
    now: new Date('2026-08-31T00:00:00.000Z'),
    signal,
  };
}

describe('symbiosisBridgeOperation under a shutdown', () => {
  it('carries the context signal into the model call, so a stop does not wait out the timeout', async () => {
    const { provider, started } = hangingProvider();
    const controller = new AbortController();
    const run = symbiosisBridgeOperation().run(contextFor(provider, controller.signal));
    const request = await started;

    controller.abort();
    const reachedTheCall = request.signal?.aborted ?? false;
    const startedAt = Date.now();
    const outcome = await run;
    const elapsedMs = Date.now() - startedAt;

    expect(reachedTheCall).toBe(true);
    expect(elapsedMs).toBeLessThan(PROMPT_RETURN_MS);
    // The deterministic sentence is the floor the model call falls back to, shutdown included.
    expect(outcome.detail).toContain('deterministic bridge');
  });
});
