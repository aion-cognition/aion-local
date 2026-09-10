import * as core from '@aion/core';
import { EvidenceResolver } from '@aion/core/evidence/application/resolver.js';
import { OWNERSHIP_SCOPES } from '@aion/core/evidence/domain/ownership.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '@aion/core/evidence/domain/scopes.js';
import {
  commitIncidence,
  establishScope,
  seedSource,
} from '@aion/core/evidence/test-support/evidence.fixture.js';
import * as provenanceQueries from '@aion/core/infrastructure/graph/claim-provenance-queries.js';
import type { GuardReceipt } from '@aion/core/infrastructure/graph/publication-receipt.js';
import * as guardReads from '@aion/core/infrastructure/graph/publication-receipt.js';
import { buildEvidenceRevision } from '@aion/core/infrastructure/publication/preconditions.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
  readCurrentCoverageContract,
} from '@aion/core/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '@aion/core/infrastructure/sqlite/database.js';
import {
  beginSubstratePairing,
  completeSubstratePairing,
} from '@aion/core/infrastructure/sqlite/publication-control.js';
import {
  prepareCoordinatorRecord,
  publicationInFlight,
} from '@aion/core/infrastructure/sqlite/publication-coordinator-store.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as output from './output.js';
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

describe('retained why completion under the checked coverage contract', () => {
  it('refuses an activation that lands inside the durable metadata read', async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    vi.spyOn(output, 'stderrWriter').mockImplementation((line) => errors.push(line));
    vi.mocked(provenanceQueries.fetchClaimProvenance).mockImplementationOnce(async () => {
      activateCoverageContract(store.db, {
        activatedAt: new Date('2026-09-02T00:00:00.000Z'),
        fieldPolicyVersion: 1,
      });
      return new Map([[NODE, { roots: [SOURCE], lineage: [SOURCE], complete: true }]]);
    });

    const code = await runWhy([NODE], (line) => lines.push(line));

    expect.soft(code).toBe(1);
    expect.soft(lines.join('\n')).not.toContain('durable evidence');
    expect.soft(errors.join('\n')).toContain('coverage_changed');
  });

  it('refuses a registry that disappears inside the durable metadata read', async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    vi.spyOn(output, 'stderrWriter').mockImplementation((line) => errors.push(line));
    vi.mocked(provenanceQueries.fetchClaimProvenance).mockImplementationOnce(async () => {
      store.db.prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_hidden').run();
      return new Map([[NODE, { roots: [SOURCE], lineage: [SOURCE], complete: true }]]);
    });
    try {
      const code = await runWhy([NODE], (line) => lines.push(line));
      expect.soft(code).toBe(1);
      expect.soft(lines.join('\n')).not.toContain('durable evidence');
      expect.soft(errors.join('\n')).toContain('coverage_store_unavailable');
    } finally {
      store.db.prepare('ALTER TABLE coverage_contract_hidden RENAME TO coverage_contract').run();
    }
  });
});

it('names pending publication uncertainty on retained-node durable evidence', async () => {
  const pairing = beginSubstratePairing(store.db, 1);
  completeSubstratePairing(store.db, pairing.substrateId);
  prepareCoordinatorRecord(
    store.db,
    {
      operationId: 'pending-semantic-write',
      kind: 'semantic_write',
      payloadJson: '{}',
      digest: 'pending-digest',
      plan: {
        expected: {
          coverageEpoch: readCurrentCoverageContract(store.db)!.epoch,
          evidence: buildEvidenceRevision([]),
          sources: [],
          heads: [],
        },
        scopes: [],
        data: {},
        effects: [],
      },
      now: AT,
    },
    true,
  );
  expect(publicationInFlight(store.db)).toBe(true);
  const lines: string[] = [];
  const code = await runWhy([NODE], (line) => lines.push(line));
  expect(code).toBe(0);
  expect.soft(lines.join('\n')).toContain('pending_publication');
  expect.soft(lines.join('\n')).not.toContain('proof            complete-for-use');
});

function pairedReceipt(): GuardReceipt {
  const pairing = beginSubstratePairing(store.db, 1);
  completeSubstratePairing(store.db, pairing.substrateId);
  const guard: GuardReceipt = {
    substrateId: pairing.substrateId,
    protocolVersion: 1,
    sequence: '0',
    operationId: null,
    intentDigest: null,
    resultDigest: null,
  };
  vi.spyOn(guardReads, 'readPublicationGuard').mockResolvedValue(guard);
  return guard;
}

function pending(): void {
  prepareCoordinatorRecord(
    store.db,
    {
      operationId: 'late-publication',
      kind: 'semantic_write',
      payloadJson: '{}',
      digest: 'late',
      plan: {
        expected: {
          coverageEpoch: readCurrentCoverageContract(store.db)!.epoch,
          evidence: buildEvidenceRevision([]),
          sources: [],
          heads: [],
        },
        scopes: [],
        data: {},
        effects: [],
      },
      now: AT,
    },
    true,
  );
}

it('control: never-paired inspection preserves the node with explicit uncertainty', async () => {
  const lines: string[] = [];
  expect(await runWhy([NODE], (line) => lines.push(line))).toBe(0);
  expect(lines.join('\n')).toContain('content  Atlas stores jobs in Valkey');
  expect(lines.join('\n')).toContain('store_unavailable');
  expect(lines.join('\n')).not.toContain('proof            complete-for-use');
});

it('control: matching complete pairing can certify the durable reading', async () => {
  pairedReceipt();
  const lines: string[] = [];
  expect(await runWhy([NODE], (line) => lines.push(line))).toBe(0);
  expect(lines.join('\n')).toContain('proof            complete-for-use');
});

it('does not certify an unfinished pairing as settled publication state', async () => {
  beginSubstratePairing(store.db, 1);
  const lines: string[] = [];
  expect(await runWhy([NODE], (line) => lines.push(line))).toBe(0);
  expect.soft(lines.join('\n')).not.toContain('proof            complete-for-use');
  expect.soft(lines.join('\n')).toContain('store_unavailable');
});

it('does not certify a graph receipt from a different substrate', async () => {
  const guard = pairedReceipt();
  vi.mocked(guardReads.readPublicationGuard).mockResolvedValue({
    ...guard,
    substrateId: 'different-substrate',
  });
  const lines: string[] = [];
  expect(await runWhy([NODE], (line) => lines.push(line))).toBe(0);
  expect.soft(lines.join('\n')).not.toContain('proof            complete-for-use');
  expect.soft(lines.join('\n')).toContain('store_unavailable');
});

it('does not certify an acknowledged sequence with no acknowledged record', async () => {
  const guard = pairedReceipt();
  store.db.prepare('UPDATE publication_control SET last_ack_sequence = 99').run();
  vi.mocked(guardReads.readPublicationGuard).mockResolvedValue({ ...guard, sequence: '99' });
  const lines: string[] = [];
  expect(await runWhy([NODE], (line) => lines.push(line))).toBe(0);
  expect.soft(lines.join('\n')).not.toContain('proof            complete-for-use');
  expect.soft(lines.join('\n')).toContain('store_unavailable');
});

it('discloses a publication landing after metadata resolution before either block is emitted', async () => {
  pairedReceipt();
  const original = EvidenceResolver.prototype.resolveMetadata;
  vi.spyOn(EvidenceResolver.prototype, 'resolveMetadata').mockImplementationOnce(async function (
    this: EvidenceResolver,
    ...args: Parameters<typeof original>
  ) {
    const batch = await original.apply(this, args);
    pending();
    return batch;
  });
  const lines: string[] = [];
  expect(await runWhy([NODE], (line) => lines.push(line))).toBe(0);
  expect(publicationInFlight(store.db)).toBe(true);
  expect.soft(lines.join('\n')).not.toContain('proof            complete-for-use');
  expect.soft(lines.join('\n')).toContain('pending_publication');
});
