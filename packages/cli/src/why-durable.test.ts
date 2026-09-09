import * as core from '@aion/core';
import { OWNERSHIP_SCOPES } from '@aion/core/evidence/domain/ownership.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '@aion/core/evidence/domain/scopes.js';
import {
  commitIncidence,
  establishScope,
  seedSource,
} from '@aion/core/evidence/test-support/evidence.fixture.js';
import * as provenanceQueries from '@aion/core/infrastructure/graph/claim-provenance-queries.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '@aion/core/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '@aion/core/infrastructure/sqlite/database.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Substrate } from './substrate.js';
import { runWhy } from './why.js';

/**
 * A node the graph still holds, whose origin edge it no longer does.
 *
 * Eviction takes the projection's edges first, so the projection's own answer to "where did this
 * come from" is the first thing to go quiet. The durable records were written when the memory
 * arrived and still name the source, the ownership behind it and how well either is proved, and
 * this is the command that has to say so rather than printing "no source episode recorded" and
 * stopping there.
 */

const NODE = 'claim-1';
const SOURCE = 'episode-1';
const SESSION = 'session-1';
const AT = new Date('2026-09-01T00:00:00.000Z');

const logger = core.openLogger({ filePath: '/dev/null', level: 'error' });
const connection = { driver: { executeQuery: () => Promise.resolve({ records: [] }) } };

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore({ filePath: ':memory:' });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: AT, fieldPolicyVersion: 1 });
  seedSource(store.db, {
    sourceId: SOURCE,
    sessionId: SESSION,
    identity: 'agent-1',
    content: { turns: [{ role: 'user', text: 'Atlas stores jobs in Valkey' }] },
    now: AT,
  });
  commitIncidence(store.db, {
    sourceId: SOURCE,
    nodeId: NODE,
    role: 'extraction',
    operationId: `extract-${NODE}`,
    at: AT,
  });
  for (const { role, direction } of OWNERSHIP_SCOPES) {
    establishScope(store.db, NODE, durableRoleScope(role, direction), AT);
  }
  establishScope(store.db, NODE, GRAPH_NODE_SCOPE, AT);
  establishScope(store.db, SOURCE, 'sqlite:stated_derivation:out', AT);
  // The ancestry walk's own read, which the graph would answer for a resident node.
  vi.spyOn(provenanceQueries, 'fetchClaimProvenance').mockResolvedValue(
    new Map([[NODE, { roots: [SOURCE], lineage: [SOURCE], complete: true }]]),
  );

  vi.spyOn(core, 'loadConfig').mockReturnValue(core.DEFAULTS);
  vi.spyOn(Substrate.prototype, 'db').mockReturnValue(store.db);
  vi.spyOn(Substrate.prototype, 'logger').mockReturnValue(logger);
  vi.spyOn(Substrate.prototype, 'connection').mockReturnValue(
    connection as unknown as core.GraphConnection,
  );
  vi.spyOn(Substrate.prototype, 'requireGraph').mockResolvedValue(
    connection as unknown as core.GraphConnection,
  );
  // The node is resident and its origin edge is not: the projection answers about the node and
  // has no `EXTRACTED_FROM` left to point at.
  vi.spyOn(core, 'fetchNodeProvenance').mockResolvedValue({
    id: NODE,
    labels: ['Insight', 'Memory', 'AionNode'],
    content: 'Atlas stores jobs in Valkey',
    currency: 'current',
    occurredAt: AT,
  });
  vi.spyOn(core, 'fetchNodeEdges').mockResolvedValue({ edges: [], complete: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe('why for a retained node with no resident origin edge', () => {
  it('reads the durable source and says how well it is proved', async () => {
    const lines: string[] = [];

    const code = await runWhy([NODE], (line: string) => lines.push(line));
    const text = lines.join('\n');

    expect(code).toBe(0);
    // The projection's own half is unchanged and still honest about what it cannot see.
    expect(text).toContain('no source episode recorded');
    // The records answer the same question, and say what stands behind the answer.
    expect(text).toContain('durable evidence');
    expect(text).toContain(`source records   ${SOURCE}`);
    expect(text).toMatch(/proof {12}\w/);
    expect(text).toContain('residency');
    expect(text).toContain(`sessions=${SESSION}`);
    expect(text).toContain('census=established');
    expect(text).toContain('citations');
  });

  it('says the citation records could not answer rather than inventing an absence', async () => {
    const lines: string[] = [];

    await runWhy([NODE], (line: string) => lines.push(line));

    expect(lines.join('\n')).toContain('the citation records could not answer');
  });
});
