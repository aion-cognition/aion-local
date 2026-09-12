import { afterEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import {
  acceptSource,
  activateCoverage,
  chunks,
  driver,
  NOW,
  prompts,
  sealFor,
  store,
} from './test-support/t10a-review.fixture.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import {
  commitIncidence,
  commitSourceState,
  establishNodeState,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import { PublicationInvariantError } from '../../infrastructure/publication/errors.js';
import { committedLinkVersions } from '../../infrastructure/sqlite/committed-evidence.js';
import { prepareRetirementVersion } from '../../infrastructure/sqlite/evidence-link-materialization.js';
import {
  acknowledgeStatedLinkVersions,
  statedLinkId,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  acknowledgeScopeAdvance,
  prepareScopeAdvance,
  publishedScopeToken,
} from '../../infrastructure/sqlite/evidence-scope.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('keeps a settled operation identity immutable and replays the exact original request', async () => {
  await activateCoverage();
  const stored = store.db
    .prepare('SELECT payload_json FROM publication_intents WHERE operation_id = ?')
    .get('review-coverage-activation') as { payload_json: string };
  const payload = JSON.parse(stored.payload_json) as {
    expectedEpoch: string;
    capabilityRevision: number;
    fieldPolicyVersion: 1;
  };
  const request = {
    kind: 'coverage_activation' as const,
    operationId: 'review-coverage-activation',
    payload,
  };
  expect((await chunks.publications.publish(request)).status).toBe('acknowledged');
  const changed = await chunks.publications
    .publish({
      ...request,
      payload: { ...payload, capabilityRevision: payload.capabilityRevision + 1 },
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  expect.soft(changed).toHaveProperty('error', expect.any(PublicationInvariantError));
  expect.soft(changed).toHaveProperty('error.retryable', false);
  expect.soft(changed).toHaveProperty('error.reason', 'operation_identity_reused');
  expect((await chunks.publications.publish(request)).status).toBe('acknowledged');
  expect(chunks.publications.hasPending()).toBe(false);
});

it('does not certify a selected positive derivation after it is retired before the content read', async () => {
  const source = await acceptSource('positive-link-member', 'A MEMBER');
  const external = await acceptSource(
    'positive-link-external',
    'THIS RELATIONSHIP MUST STILL EXIST',
  );
  const nodeId = 'positive-link-retained-node';
  await writeStampedNode(driver, {
    label: 'Insight',
    id: nodeId,
    now: NOW,
    properties: { text: 'retained interpretation context' },
  });
  await upsertEdge(driver, {
    type: 'EXTRACTED_FROM',
    sourceId: nodeId,
    targetId: source,
    strength: 1,
    confidence: 1,
    count: 0,
    signals: [],
    provenance: ['review'],
    now: NOW,
  });
  commitIncidence(store.db, {
    sourceId: source,
    nodeId,
    role: 'extraction',
    operationId: 'positive-incidence',
    at: NOW,
  });
  for (const scope of [
    durableRoleScope('extraction', 'out'),
    durableRoleScope('stated_correction', 'in'),
    durableRoleScope('stated_confirmation', 'in'),
  ]) {
    establishScope(store.db, nodeId, scope, NOW);
  }
  establishNodeState(store.db, nodeId, { revision: 1, at: NOW });
  const chunk = await sealFor(source);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  const linkId = statedLinkId('derived_from', 'retained_node', external, nodeId);
  const scope = durableRoleScope('stated_derivation', 'in');
  expect(
    await chunks.publications.publish({
      kind: 'stated_references',
      operationId: 'positive-derivation',
      payload: {
        sourceId: external,
        supersedes: [],
        derivedFrom: [nodeId],
        confirmations: [],
        deliveryKey: 'positive-derivation',
        observedAt: NOW.toISOString(),
      },
    }),
  ).toMatchObject({ status: 'acknowledged' });
  expect(committedLinkVersions(store.db, linkId).at(-1)?.state).toBe('stated');
  // This fixture knows the whole incoming derivation population; availability is not the issue.
  establishScope(store.db, nodeId, scope, NOW);
  const before = publishedScopeToken(store.db, { endpointId: nodeId, relationClass: scope });
  expect(before).toBeDefined();
  establishNodeState(store.db, nodeId, { revision: 2, at: NOW });
  const original = chunks.resolver.resolveSources.bind(chunks.resolver);
  let retired = false;
  vi.spyOn(chunks.resolver, 'resolveSources').mockImplementation(async (...args) => {
    if (!retired && JSON.stringify(args[0]).includes(external)) {
      retired = true;
      store.db
        .transaction(() => {
          commitSourceState(store.db, {
            sourceId: external,
            stateKind: 'unforgotten',
            operationId: 'positive-retired',
            at: NOW,
          });
          prepareRetirementVersion(store.db, {
            linkId,
            operationId: 'positive-retired',
            operationKey: 'positive-retired',
            recordedValues: {},
            temporalProof: {},
            observedAt: NOW,
          });
          acknowledgeStatedLinkVersions(
            store.db,
            'positive-retired',
            NOW.toISOString(),
            NOW.toISOString(),
          );
          prepareScopeAdvance(store.db, {
            endpointId: nodeId,
            relationClass: scope,
            operationId: 'positive-retired',
            updatedAt: NOW,
          });
          acknowledgeScopeAdvance(store.db, {
            endpointId: nodeId,
            relationClass: scope,
            operationId: 'positive-retired',
            updatedAt: NOW,
          });
        })
        .immediate();
      expect(publishedScopeToken(store.db, { endpointId: nodeId, relationClass: scope })).not.toBe(
        before,
      );
    }
    return original(...args);
  });
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(retired).toBe(true);
  expect(committedLinkVersions(store.db, linkId).at(-1)?.state).toBe('retired');
  if (result.status === 'published') {
    expect(prompts.at(-1)).not.toContain('THIS RELATIONSHIP MUST STILL EXIST');
  }
});
