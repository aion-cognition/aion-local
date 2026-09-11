import { afterEach, expect, it, vi } from 'vitest';

import { deps, provider, seedLegacy } from './c3ru-astra.fixture.js';
import { ensureSessionFamily } from './narrative-family.js';
import { rollUpNarratives } from './narrative-rollup.js';
import { closeSessionNarrative } from './narratives.js';
import {
  acceptSource,
  activateCoverage,
  chunks,
  driver,
  publications,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import {
  readRelationScope,
  verifyEvidenceRevision,
} from '../../evidence/application/dependencies.js';
import { nodeRoleScope } from '../../evidence/domain/scopes.js';
import * as queries from '../../infrastructure/graph/narrative-rollup-queries.js';
import { edgeValidUntil } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';

async function seedOwned(tag: string, day: string): Promise<string> {
  const sourceId = await acceptSource(`session-${tag}`, tag);
  const sessionId = sessionOf(sourceId);
  const nodeId = `narrative-${tag}`;
  await seedLegacy({
    nodeId,
    sessionId,
    sourceId,
    occurredAt: new Date(`${day}T06:00:00Z`),
    text: `${tag}: the legacy source is complete.`,
  });
  expect((await ensureSessionFamily(chunks, sessionId)).status).toBe('ready');
  return nodeId;
}

it.each([false, true])(
  'keeps the pre-synthesis coverage epoch when activation moves=%s',
  async (moves) => {
    const day = moves ? '2026-10-02' : '2026-10-01';
    const tag = `epoch-${String(moves)}`;
    await seedOwned(tag, day);
    const held = readCurrentCoverageContract(store.db)?.epoch;
    let intercepted = false;
    const wrapped: Provider = {
      embed: provider.embed,
      generate: async (request) => {
        const text = request.messages.map((message) => message.content).join(' ');
        if (!intercepted && text.includes(tag) && !text.includes('You review a draft memory')) {
          intercepted = true;
          if (moves) {
            await activateCoverage();
            expect(readCurrentCoverageContract(store.db)?.epoch).not.toBe(held);
          }
        }
        return provider.generate(request);
      },
    };
    await rollUpNarratives(
      { ...deps(), provider: wrapped },
      {
        scope: 'day',
        now: new Date('2026-10-04T00:00:00Z'),
        windowLimit: 20,
        renderedInputAllowance: 32768,
      },
    );
    expect(intercepted).toBe(true);
    expect(await queries.findWindowRollups(driver, 'day', day)).toHaveLength(moves ? 0 : 1);
  },
);

it('does not publish a stale smaller window after a peer published its grown population', async () => {
  const day = '2026-10-10';
  await seedOwned('old-window-read', day);
  let peerPublished = false;
  const wrapped: Provider = {
    embed: provider.embed,
    generate: async (request) => {
      const text = request.messages.map((message) => message.content).join(' ');
      if (
        !peerPublished &&
        text.includes('old-window-read') &&
        !text.includes('You review a draft memory')
      ) {
        peerPublished = true;
        await seedOwned('late-window-member', day);
        await rollUpNarratives(deps(), {
          scope: 'day',
          now: new Date('2026-10-11T00:00:00Z'),
          windowLimit: 20,
          renderedInputAllowance: 32768,
        });
        const peer = await queries.findWindowRollups(driver, 'day', day);
        expect(peer).toHaveLength(1);
        expect(peer[0]?.coverageCount).toBe(2);
      }
      return provider.generate(request);
    },
  };
  await rollUpNarratives(
    { ...deps(), provider: wrapped },
    {
      scope: 'day',
      now: new Date('2026-10-11T00:00:00Z'),
      windowLimit: 20,
      renderedInputAllowance: 32768,
    },
  );
  expect(peerPublished).toBe(true);
  const heads = await queries.findWindowRollups(driver, 'day', day);
  expect(heads.filter((head) => head.open)).toHaveLength(1);
  expect(heads.find((head) => head.open)?.coverageCount).toBe(2);
});

it('retires the durable coverage it closes and invalidates an issued coverage proof', async () => {
  const at = new Date('2026-10-20T06:00:00Z');
  const sourceId = await acceptSource(
    'coverage-writer-session',
    'durable coverage source',
    true,
    at,
  );
  const sessionId = sessionOf(sourceId);
  await seedLegacy({
    nodeId: 'original-coverage-representation',
    sessionId,
    sourceId,
    occurredAt: at,
    text: 'The original legacy version precedes its controlled rewrite.',
  });
  const legacy = await closeSessionNarrative({ ...deps(), resolver: chunks.resolver }, sessionId, {
    now: at,
    regenerate: true,
  });
  expect(legacy.status).toBe('created');
  const nodeId = legacy.narrativeId ?? '';
  const scope = readRelationScope(store.db, {
    kind: 'relation_scope',
    endpointId: nodeId,
    scope: nodeRoleScope('source_coverage'),
    empty: false,
  });
  expect(scope.status).toBe('verified');
  if (scope.status !== 'verified') {
    throw new Error('the real legacy producer must establish coverage first');
  }
  const before = buildEvidenceRevision([scope.dependency]);
  expect(verifyEvidenceRevision(store.db, before).status).toBe('current');
  await rollUpNarratives(deps(), {
    scope: 'day',
    now: new Date('2026-10-21T00:00:00Z'),
    windowLimit: 20,
    renderedInputAllowance: 32768,
  });
  expect(await queries.findWindowRollups(driver, 'day', '2026-10-20')).toHaveLength(1);
  expect(await edgeValidUntil(driver, 'SUMMARIZED_BY', sourceId, nodeId)).toBeDefined();
  expect.soft(verifyEvidenceRevision(store.db, before).status).toBe('stale');
  expect
    .soft(
      store.db
        .prepare(
          "SELECT currency FROM source_incidence WHERE source_id = ? AND node_id = ? AND role = 'source_coverage'",
        )
        .get(sourceId, nodeId),
    )
    .toEqual({ currency: 'closed' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('binds coverage before member contents are read, not at the later ownership proof', async () => {
  const day = '2026-10-30';
  const id = await seedOwned('before-family-proof', day);
  const epoch = readCurrentCoverageContract(store.db)?.epoch;
  const original = queries.findRollupMembers;
  let intercepted = false;
  vi.spyOn(queries, 'findRollupMembers').mockImplementation(async (...args) => {
    const rows = await original(...args);
    if (!intercepted && rows.some((row) => row.id === id)) {
      intercepted = true;
      store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
      const outcome = await publications.publish({
        kind: 'coverage_activation',
        operationId: 'review-before-family-proof-activation',
        payload: { expectedEpoch: epoch, capabilityRevision: 1, fieldPolicyVersion: 1 },
      });
      expect(outcome.status).toBe('acknowledged');
      expect(readCurrentCoverageContract(store.db)?.epoch).not.toBe(epoch);
    }
    return rows;
  });
  await rollUpNarratives(deps(), {
    scope: 'day',
    now: new Date('2026-10-31T00:00:00Z'),
    windowLimit: 20,
    renderedInputAllowance: 32768,
  });
  expect(intercepted).toBe(true);
  expect(await queries.findWindowRollups(driver, 'day', day)).toEqual([]);
});
