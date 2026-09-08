import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { JudgmentPair } from './judgment.js';
import { EvidenceResolver } from './resolver.js';
import type { CheckpointResult } from '../../infrastructure/publication/types.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { recordScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';
import { GRAPH_NODE_SCOPE } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  establishNodeState,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

/**
 * The boundary the resolver has to hold at once: what a walk may materialize, what a revision
 * has to name, which vantage a historical answer comes from, and what one request may learn from
 * another. Each case here is a reviewer's, kept with its own assertions.
 */

const NOW = new Date('2026-09-08T10:00:00.000Z');

let dir: string;
let store: SqliteStore;

const emptyDriver = { executeQuery: () => Promise.resolve({ records: [] }) } as unknown as Driver;

function ready(sequence = '1'): CheckpointResult {
  return {
    status: 'ready',
    checkpoint: {
      substrateId: 'substrate',
      protocolVersion: 1,
      sequence,
      operationId: null,
      intentDigest: null,
      resultDigest: null,
    },
  };
}

function resolver(checkpoint: () => Promise<CheckpointResult> = () => Promise.resolve(ready())) {
  return new EvidenceResolver({
    driver: emptyDriver,
    db: store.db,
    logger: { warn: () => undefined },
    publications: { checkpoint },
  });
}

function source(id: string): void {
  seedSource(store.db, {
    sourceId: id,
    sessionId: 'session',
    identity: 'agent',
    content: { turns: [{ role: 'user', text: `${id} raw exchange` }] },
    turnIds: [`${id}-turn`],
    now: NOW,
  });
  establishScope(store.db, id, 'sqlite:stated_derivation:out', NOW);
  establishScope(store.db, id, 'source.state', NOW);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-read-boundary-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  for (const id of ['left', 'right', 'root']) {
    source(id);
  }
  for (const [id, origin] of [
    ['old', 'left'],
    ['new', 'right'],
  ]) {
    commitIncidence(store.db, {
      sourceId: origin!,
      nodeId: id!,
      role: 'extraction',
      operationId: `extract-${id!}`,
      at: NOW,
    });
    for (const scope of [
      'sqlite:extraction:out',
      'sqlite:mention:in',
      'sqlite:participation:in',
      'sqlite:stated_correction:in',
    ]) {
      establishScope(store.db, id!, scope, NOW);
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('includes the judged node state in the revision it confirms', async () => {
  for (const id of ['old', 'new']) {
    establishNodeState(store.db, id, { revision: 1, at: NOW });
  }
  const pair: JudgmentPair = {
    route: 'claim_dedup',
    use: 'claim_judgment',
    reservedUnits: 0,
    sides: [
      { nodeId: 'old', statement: 'old statement' },
      { nodeId: 'new', statement: 'new statement' },
    ],
  };
  const r = resolver();
  const result = await r.assembleJudgment(pair, checkedContext());
  expect(result.status).toBe('assembled');
  recordScopeMirror(store.db, {
    endpointId: 'old',
    relationClass: GRAPH_NODE_SCOPE,
    mirroredRevision: 2,
    operationId: 'changed-old',
    mirroredAt: NOW,
  });
  expect(r.confirm(result.revision).status).not.toBe('current');
});
