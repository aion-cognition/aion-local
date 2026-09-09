import {
  assemblePack,
  openLogger,
  ReflectionNotStoredError,
  type BucketCaps,
  type FusedItem,
  type Logger,
} from '@aion/core';
import {
  PublicationInvariantError,
  PublicationPendingError,
  PublicationRetryableError,
  PublicationUnavailable,
} from '@aion/core/infrastructure/publication/errors.js';
import { admittedAll } from '@aion/core/recall/domain/test-support/admission.fixture.js';
import {
  MemoryPackSchema,
  RecallRefusalSchema,
  type CoverageRefusal,
  type Cue,
  type MemoryPack,
  type RecallRefusal,
  type StageTimingsMs,
} from '@aion/protocol';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { refusingArchiveBackend } from './archive-backend.fixture.js';
import { DESCRIPTIONS_VERSION, DESCRIPTIONS_VERSION_META_KEY } from './descriptions.js';
import { callTool, TOOL_DEFINITIONS, type ToolBackend } from './tools.js';

const CAPS: BucketCaps = {
  facts: 15,
  episodes: 5,
  narratives: 5,
  intentions: 3,
  preferences: 3,
  resonant: 5,
};
const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];
const TIMINGS: StageTimingsMs = { embed: 12, cues: 340, seeds: 55, activation: 80, fusion: 4 };

const EPISODE: FusedItem = {
  id: 'episode-1',
  labels: ['Episode', 'Memory', 'AionNode'],
  content: 'we picked webhooks because polling was too slow',
  occurredAt: new Date('2026-06-01T11:00:00.000Z'),
  rationale: { method: 'vector', score: 0.81 },
  relevance: 0.81,
  measured: 0.81,
  score: 0.02,
  currency: 'current',
};

/** Stands in for a conversation payload: it must never reach the log on an internal failure. */
const SECRET_QUERY = 'a-query-that-must-not-be-logged';

let dir: string;
let logger: Logger;
let logPath: string;

function pack(): MemoryPack {
  return assemblePack({
    items: [EPISODE],
    admission: admittedAll(1),
    caps: CAPS,
    tokenBudget: 1200,
    cues: CUES,
    timings: TIMINGS,
  });
}

function backendReturning(): ToolBackend {
  return {
    recall: () => Promise.resolve(pack()),
    reflection: () =>
      Promise.resolve({ episode_id: 'episode-1', queued: true, lane: 'interactive' } as const),
    ...refusingArchiveBackend(),
  };
}

function backendThrowing(err: Error): ToolBackend {
  return {
    recall: () => Promise.reject(err),
    reflection: () => Promise.reject(err),
    ...refusingArchiveBackend(),
  };
}

function logText(): string {
  return readFileSync(logPath, 'utf8');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-mcp-tools-'));
  logPath = join(dir, 'aion.jsonl');
  logger = openLogger({ filePath: logPath, level: 'debug' });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tool definitions', () => {
  it('registers every tool, each stamped with the description version', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'recall',
      'reflection',
      'source_search',
      'source',
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool._meta?.[DESCRIPTIONS_VERSION_META_KEY]).toBe(DESCRIPTIONS_VERSION);
      expect(tool.description ?? '').not.toBe('');
    }
  });

  it('publishes the protocol schema itself, so the advertised contract is the enforced one', () => {
    const recall = TOOL_DEFINITIONS[0];
    expect(recall?.inputSchema.type).toBe('object');
    expect(recall?.inputSchema.required).toEqual(['query']);
    expect(Object.keys(recall?.inputSchema.properties ?? {})).toEqual([
      'query',
      'context',
      'budget',
      'session_id',
      'as_of',
      'knew_at',
      'reset_delivery_suppression',
    ]);
    expect(recall?.inputSchema.additionalProperties).toBe(false);

    const reflection = TOOL_DEFINITIONS[1];
    expect(Object.keys(reflection?.inputSchema.properties ?? {})).toEqual([
      'turns',
      'tool_executions',
      'observations',
      'summary',
      'session_id',
      'lane',
      'origin',
      'provenance',
      'feedback',
    ]);
  });

  it('advertises output schemas a client can compile and hold the results to', () => {
    const validator = new AjvJsonSchemaValidator();
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.outputSchema).toBeDefined();
    }

    const recallValidator = validator.getValidator(TOOL_DEFINITIONS[0]?.outputSchema ?? {});
    expect(recallValidator(pack()).valid).toBe(true);

    const reflectionValidator = validator.getValidator(TOOL_DEFINITIONS[1]?.outputSchema ?? {});
    expect(
      reflectionValidator({ episode_id: 'episode-1', queued: true, lane: 'interactive' }).valid,
    ).toBe(true);
  });
});

const REFUSAL: CoverageRefusal = {
  contract_version: 1,
  reason: 'before_horizon',
  requested: { knew_at: '2026-01-01T00:00:00.000Z', now: '2026-09-08T12:00:00.000Z' },
  bounds: { history_since: '2026-09-08T02:00:00.000Z', coverage_state: 'active' },
};

function refused(): RecallRefusal {
  return { status: 'coverage_refusal', coverage_refusal: REFUSAL };
}

describe('recall results', () => {
  it('returns the rendered block as text and the pack as structured content', async () => {
    const result = await callTool(
      backendReturning(),
      logger,
      'recall',
      { query: 'why webhooks' },
      'session-a',
    );

    expect(result.content).toEqual([{ type: 'text', text: pack().rendered_text }]);
    expect(MemoryPackSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  /**
   * A refusal is its own branch, on both halves of the answer. A client that renders only the
   * text block is told the request was refused rather than that nothing was found, and one that
   * parses `structuredContent` branches on `status` instead of hitting an unparseable pack.
   */
  it('returns a refusal as its own branch, in the text and in the structure', async () => {
    const backend: ToolBackend = {
      ...backendReturning(),
      recall: () => Promise.resolve(refused()),
    };

    const result = await callTool(backend, logger, 'recall', { query: 'q' }, 'session-a');

    expect(result.structuredContent).toEqual(refused());
    expect(RecallRefusalSchema.safeParse(result.structuredContent).success).toBe(true);
    expect(MemoryPackSchema.safeParse(result.structuredContent).success).toBe(false);
    const { text } = result.content[0] as { text: string };
    expect(text).toContain('before_horizon');
    expect(text).toContain('2026-09-08T02:00:00.000Z');
    expect(result.isError).toBeUndefined();
  });

  it('publishes both branches, with the successful one exactly as it was advertised before', () => {
    const validator = new AjvJsonSchemaValidator();
    const advertised = (TOOL_DEFINITIONS[0]?.outputSchema ?? {}) as Record<string, unknown>;
    const compiled = validator.getValidator(advertised);

    expect(compiled(pack()).valid).toBe(true);
    expect(compiled(refused()).valid).toBe(true);
    expect(advertised.type).toBe('object');
    const branches = advertised.anyOf as readonly unknown[];
    const packSchema = z.toJSONSchema(MemoryPackSchema, { io: 'output' }) as Record<
      string,
      unknown
    >;
    delete packSchema.$schema;
    expect(branches[0]).toEqual(packSchema);
  });
});

describe('reflection results', () => {
  it('acks in one line and returns the episode id structurally', async () => {
    const result = await callTool(
      backendReturning(),
      logger,
      'reflection',
      { observations: ['we picked webhooks'] },
      'session-a',
    );

    expect(result.content).toEqual([
      { type: 'text', text: 'Stored episode episode-1; queued for reflection (interactive lane).' },
    ]);
    expect(result.structuredContent).toEqual({
      episode_id: 'episode-1',
      queued: true,
      lane: 'interactive',
    });
  });

  // Applies to the ack too: a text-only client has no other way to see how far behind
  // live traffic its own memory queued.
  it('names how many interactive jobs are ahead of it, in the rendered text', async () => {
    const backend: ToolBackend = {
      recall: () => Promise.resolve(pack()),
      reflection: () =>
        Promise.resolve({
          episode_id: 'episode-1',
          queued: true,
          lane: 'interactive',
          pending_ahead: 3,
        } as const),
      ...refusingArchiveBackend(),
    };

    const result = await callTool(
      backend,
      logger,
      'reflection',
      { observations: ['x'] },
      'session-a',
    );

    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Stored episode episode-1; queued for reflection (interactive lane). 3 interactive jobs ahead of it.',
      },
    ]);
  });

  it('omits the pending-ahead clause when there is nothing ahead of it', async () => {
    const backend: ToolBackend = {
      recall: () => Promise.resolve(pack()),
      reflection: () =>
        Promise.resolve({
          episode_id: 'episode-1',
          queued: true,
          lane: 'interactive',
          pending_ahead: 0,
        } as const),
      ...refusingArchiveBackend(),
    };

    const result = await callTool(
      backend,
      logger,
      'reflection',
      { observations: ['x'] },
      'session-a',
    );

    expect(result.content).toEqual([
      { type: 'text', text: 'Stored episode episode-1; queued for reflection (interactive lane).' },
    ]);
  });
});

describe('error mapping', () => {
  it('reports a rejected payload as invalid params, carrying the zod message', async () => {
    const parsed = z.object({ query: z.string() }).safeParse({});
    if (parsed.success) {
      throw new Error('expected the zod parse to fail');
    }
    const zodError = parsed.error;

    const err = await callTool(backendThrowing(zodError), logger, 'recall', {}, 'session-a').catch(
      (caught: unknown) => caught,
    );

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((err as McpError).message).toContain('recall');
    expect((err as McpError).message).toContain('query');
  });

  it('reports anything else as an internal error naming the failure class, not the payload', async () => {
    const err = await callTool(
      backendThrowing(new TypeError('driver exploded')),
      logger,
      'recall',
      { query: SECRET_QUERY },
      'session-a',
    ).catch((caught: unknown) => caught);

    expect((err as McpError).code).toBe(ErrorCode.InternalError);
    expect((err as McpError).message).toContain('TypeError');
    expect((err as McpError).message).not.toContain(SECRET_QUERY);
  });

  // The class name is all the caller used to get, and "reflection failed (TypeError)" does
  // not say whether the experience was kept. This one message does.
  it('carries the reflection-not-stored message through to the caller', async () => {
    const err = await callTool(
      backendThrowing(new ReflectionNotStoredError('graph', new TypeError('connect ECONNREFUSED'))),
      logger,
      'reflection',
      { observations: [SECRET_QUERY] },
      'session-a',
    ).catch((caught: unknown) => caught);

    expect((err as McpError).code).toBe(ErrorCode.InternalError);
    expect((err as McpError).message).toContain('reflection not stored');
    expect((err as McpError).message).toContain('nothing was queued');
    expect((err as McpError).message).not.toContain(SECRET_QUERY);
  });

  it('logs the internal failure with its stack and never the arguments', () => {
    const text = logText();
    expect(text).toContain('tool call failed');
    expect(text).toContain('driver exploded');
    expect(text).toContain('tools.test.ts');
    expect(text).not.toContain(SECRET_QUERY);
  });

  it('rejects a tool it does not register', async () => {
    const err = await callTool(backendReturning(), logger, 'forget', {}, 'session-a').catch(
      (caught: unknown) => caught,
    );

    expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
  });
});

/**
 * The terms of a publication failure, as structure rather than as a class name inside a
 * sentence. A client deciding whether to send the same request again was matching that string
 * before this; nothing about the wording was a contract.
 *
 * The backend is a stub throwing the failure classes themselves, so what is exercised here is
 * the mapping and nothing behind it.
 */
describe('publication failure data', () => {
  const OPERATION = 'intake:0b0f6c1e-7f8a-4a2b-9f77-6d1c4d0f6a51';
  /** Stands in for the native diagnostic: it names nodes and transactions and must not travel. */
  const INTERNAL_CAUSE = new Error(
    'ForsetiClient[transactionId=819] deadlock wait cycle NODE(339)',
  );

  async function dataFor(err: Error): Promise<unknown> {
    const caught = await callTool(
      backendThrowing(err),
      logger,
      'reflection',
      { observations: [SECRET_QUERY] },
      'session-a',
    ).catch((raised: unknown) => raised);
    expect(caught).toBeInstanceOf(McpError);
    expect((caught as McpError).code).toBe(ErrorCode.InternalError);
    return (caught as McpError).data;
  }

  it('carries retryability, the reason and the delivery identity for a recognized transient failure', async () => {
    const data = await dataFor(
      new PublicationRetryableError('store_unavailable', OPERATION, { cause: INTERNAL_CAUSE }),
    );

    expect(data).toEqual({
      retryable: true,
      reason: 'store_unavailable',
      operationId: OPERATION,
    });
  });

  it('carries the same terms for a publication left pending after a commit attempt', async () => {
    const data = await dataFor(new PublicationPendingError(OPERATION, INTERNAL_CAUSE));

    expect(data).toEqual({ retryable: true, reason: 'pending_recovery', operationId: OPERATION });
  });

  // Retryability is the class's own answer. An invariant failure is a refusal to guess, and a
  // client that retried it would get the same refusal.
  it('never reports an invariant or unclassified publication failure as retryable', async () => {
    const invariant = await dataFor(new PublicationInvariantError('pending_slot_mismatch'));
    const unclassified = await dataFor(new PublicationUnavailable('publication_failed', OPERATION));

    expect(invariant).toEqual({ retryable: false, reason: 'pending_slot_mismatch' });
    expect(unclassified).toEqual({
      retryable: false,
      reason: 'publication_failed',
      operationId: OPERATION,
    });
  });

  // Recognition is by class, so an unrelated failure carrying the same field name gains nothing.
  it('attaches nothing to a failure it does not recognize, however it is shaped', async () => {
    const impostor = Object.assign(new TypeError('driver exploded'), {
      retryable: true,
      reason: 'store_unavailable',
    });

    expect(await dataFor(impostor)).toBeUndefined();
    expect(await dataFor(new TypeError('driver exploded'))).toBeUndefined();
  });

  it('leaves a rejected payload as invalid params, with no data and no retry claim', async () => {
    const parsed = z.object({ query: z.string() }).safeParse({});
    if (parsed.success) {
      throw new Error('expected the zod parse to fail');
    }

    const err = await callTool(
      backendThrowing(parsed.error),
      logger,
      'reflection',
      { observations: [SECRET_QUERY] },
      'session-a',
    ).catch((caught: unknown) => caught);

    expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
    expect((err as McpError).data).toBeUndefined();
  });

  it('names the failure class in prose and carries neither the cause nor the payload', async () => {
    const err = await callTool(
      backendThrowing(
        new PublicationRetryableError('store_unavailable', OPERATION, { cause: INTERNAL_CAUSE }),
      ),
      logger,
      'reflection',
      { observations: [SECRET_QUERY] },
      'session-a',
    ).catch((caught: unknown) => caught);

    const raised = err as McpError;
    const wire = JSON.stringify({ message: raised.message, data: raised.data });
    expect(raised.message).toContain('PublicationRetryableError');
    expect(wire).not.toContain(SECRET_QUERY);
    expect(wire).not.toContain('Forseti');
    expect(logText()).not.toContain(SECRET_QUERY);
  });
});
