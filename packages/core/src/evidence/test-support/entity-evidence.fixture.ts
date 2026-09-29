import {
  commitIncidence,
  establishNodeState,
  establishScope,
  seedSource,
} from './evidence.fixture.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { durableRoleScope } from '../domain/scopes.js';

/**
 * Seeding for an entity pair judged through the real evidence seam: the counted scopes and node
 * state each side needs, and captures shaped like the long hook captures that used to overflow
 * the whole-source read.
 */

/** An entity whose node state and every role it is read through are counted. */
export function establishEntityEvidence(db: SqliteHandle, nodeId: string, at: Date): void {
  for (const role of ['mention', 'participation', 'stated_correction'] as const) {
    establishScope(db, nodeId, durableRoleScope(role, 'in'), at);
  }
  establishNodeState(db, nodeId, { revision: 1, at });
}

/**
 * A whole agent turn as a Stop hook captures it, about 97 KB: a 40 KB assistant turn and 64 tool
 * executions, with the name spelled in the long turn and once more in tool execution 40.
 */
export function stopCapture(name: string, occurredAt: Date): ReflectionContent {
  return {
    turns: [
      { role: 'user', text: 'carry on with the migration', occurred_at: occurredAt.toISOString() },
      { role: 'assistant', text: `${name} was checked. ${'y'.repeat(40_000)}` },
    ],
    tool_executions: Array.from({ length: 64 }, (_, tool) => ({
      tool: 'Read',
      status: 'ok' as const,
      input: { path: `/repo/file-${String(tool)}` },
      output:
        tool === 40
          ? `${name} is the service that owns this queue. ${'z'.repeat(780)}`
          : 'z'.repeat(850),
    })),
  };
}

/** One accepted source, recorded in the committed view against each of `nodeIds`. */
export function seedEntitySource(
  db: SqliteHandle,
  input: {
    readonly sourceId: string;
    readonly sessionId: string;
    readonly content: ReflectionContent;
    readonly nodeIds: readonly string[];
    readonly at: Date;
  },
): void {
  seedSource(db, {
    sourceId: input.sourceId,
    sessionId: input.sessionId,
    identity: input.sessionId,
    content: input.content,
    turnIds: (input.content.turns ?? []).map(
      (_, index) => `${input.sourceId}-turn-${String(index)}`,
    ),
    now: input.at,
  });
  for (const nodeId of input.nodeIds) {
    commitIncidence(db, {
      sourceId: input.sourceId,
      nodeId,
      role: 'mention',
      operationId: `mention:${input.sourceId}:${nodeId}`,
      at: input.at,
    });
  }
}
