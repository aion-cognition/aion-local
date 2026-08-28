import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemblePack, openLogger, type BucketCaps, type FusedItem, type Logger } from '@aion/core';
import { MemoryPackSchema, type Cue, type MemoryPack, type StageTimingsMs } from '@aion/protocol';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DESCRIPTIONS_VERSION, DESCRIPTIONS_VERSION_META_KEY } from './descriptions.js';
import { callTool, TOOL_DEFINITIONS, type ToolBackend } from './tools.js';

const CAPS: BucketCaps = { facts: 15, episodes: 5, narratives: 5, preferences: 3, resonant: 5 };
const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];
const TIMINGS: StageTimingsMs = { embed: 12, cues: 340, seeds: 55, activation: 80, fusion: 4 };

const EPISODE: FusedItem = {
  id: 'episode-1',
  labels: ['Episode', 'Memory', 'AionNode'],
  content: 'we picked webhooks because polling was too slow',
  occurredAt: new Date('2026-06-01T11:00:00.000Z'),
  rationale: { method: 'vector', score: 0.81 },
  relevance: 0.81,
  score: 0.02,
  currency: 'current',
};

/** Stands in for a conversation payload: it must never reach the log on an internal failure. */
const SECRET_QUERY = 'a-query-that-must-not-be-logged';

let dir: string;
let logger: Logger;
let logPath: string;

function pack(): MemoryPack {
  return assemblePack({ items: [EPISODE], caps: CAPS, tokenBudget: 1200, cues: CUES, timings: TIMINGS });
}

function backendReturning(): ToolBackend {
  return {
    recall: () => Promise.resolve(pack()),
    reflection: () => Promise.resolve({ episode_id: 'episode-1', queued: true } as const),
  };
}

function backendThrowing(err: unknown): ToolBackend {
  return {
    recall: () => Promise.reject(err),
    reflection: () => Promise.reject(err),
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
  it('registers recall and reflection, each stamped with the description version', () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(['recall', 'reflection']);
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
    ]);
    expect(recall?.inputSchema['additionalProperties']).toBe(false);

    const reflection = TOOL_DEFINITIONS[1];
    expect(Object.keys(reflection?.inputSchema.properties ?? {})).toEqual([
      'turns',
      'tool_executions',
      'observations',
      'summary',
      'session_id',
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
    expect(reflectionValidator({ episode_id: 'episode-1', queued: true }).valid).toBe(true);
  });
});

describe('recall results', () => {
  it('returns the rendered block as text and the pack as structured content', async () => {
    const result = await callTool(backendReturning(), logger, 'recall', { query: 'why webhooks' }, 'session-a');

    expect(result.content).toEqual([{ type: 'text', text: pack().rendered_text }]);
    expect(MemoryPackSchema.safeParse(result.structuredContent).success).toBe(true);
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
      { type: 'text', text: 'Stored episode episode-1; queued for reflection.' },
    ]);
    expect(result.structuredContent).toEqual({ episode_id: 'episode-1', queued: true });
  });
});

describe('error mapping', () => {
  it('reports a rejected payload as invalid params, carrying the zod message', async () => {
    const parsed = z.object({ query: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    const zodError = parsed.success ? undefined : parsed.error;

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
