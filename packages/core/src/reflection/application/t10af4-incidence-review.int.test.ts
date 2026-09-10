import { expect, it } from 'vitest';

import { chunkTransitionEvidence } from './chunk-transition.js';
import { acceptSource, chunks, driver, NOW, store } from './test-support/t10a-review.fixture.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import {
  commitIncidence,
  establishNodeState,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import {
  acknowledgeStatedLinkVersions,
  prepareRetirementVersion,
} from '../../infrastructure/sqlite/evidence-links.js';
import { publishedScopeToken } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';
import { commitSourceIncidence } from '../../infrastructure/sqlite/source-incidence.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';

it('keeps a selected incidence fact bound after the content read returns', async () => {
  const member = await acceptSource('incidence-bound-member', 'frozen member');
  const external = await acceptSource('incidence-bound-external', 'selected external evidence');
  const nodeId = 'incidence-bound-retained';
  await writeStampedNode(driver, {
    label: 'Insight',
    id: nodeId,
    now: NOW,
    properties: { text: 'retained interpretation' },
  });
  commitIncidence(store.db, {
    sourceId: external,
    nodeId,
    role: 'extraction',
    operationId: 'incidence-bound-add',
    at: NOW,
  });
  const linkId = `${external}:${nodeId}:extraction`;
  // EXTRACTED_FROM is node-to-source. The source's outgoing-reference digest does not own it.
  store.db
    .prepare('UPDATE evidence_links SET from_id = ?, to_id = ? WHERE link_id = ?')
    .run(nodeId, external, linkId);
  for (const role of ['stated_correction', 'stated_confirmation', 'stated_derivation'] as const) {
    establishScope(store.db, nodeId, durableRoleScope(role, 'in'), NOW);
  }
  establishScope(store.db, nodeId, durableRoleScope('extraction', 'out'), NOW);
  establishScope(store.db, external, durableRoleScope('extraction', 'in'), NOW);
  establishNodeState(store.db, nodeId, { revision: 2, at: NOW });
  const checked = checkPresentCoverage(store.db, NOW);
  if (checked.status !== 'checked') {
    throw new Error('fixture coverage unavailable');
  }
  const result = await chunkTransitionEvidence(
    chunks,
    [{ kind: 'node', id: nodeId, scope: GRAPH_NODE_SCOPE, version: '1' }],
    [member],
    checked.context,
  );
  expect(result.readings).toEqual(
    expect.arrayContaining([expect.objectContaining({ sourceId: external, reading: 'complete' })]),
  );
  expect(result.unprovedScopes).toEqual([]);
  const held = buildEvidenceRevision(result.dependencies);
  expect(verifyEvidenceRevision(store.db, held).status).toBe('current');
  const extractionScope = {
    endpointId: nodeId,
    relationClass: durableRoleScope('extraction', 'out'),
  };
  const extractionBefore = publishedScopeToken(store.db, extractionScope);
  expect(extractionBefore).toBeDefined();
  store.db
    .transaction(() => {
      const operationId = 'incidence-bound-retired';
      preparePublicationIntent(store.db, {
        operationId,
        kind: 'topology_update',
        payloadDigest: 'fixture',
        payloadJson: '{}',
        affectedScopesJson: '[]',
        expectedJson: '{}',
        preparedActionsJson: '[]',
        createdAt: NOW,
      });
      const version = prepareRetirementVersion(store.db, {
        linkId,
        operationId,
        operationKey: operationId,
        recordedValues: {},
        temporalProof: {},
        observedAt: NOW,
      });
      if (version === undefined) {
        throw new Error('fixture retirement was not prepared');
      }
      acknowledgeStatedLinkVersions(store.db, operationId, NOW.toISOString(), NOW.toISOString());
      acknowledgePublicationIntent(store.db, {
        operationId,
        resultDigest: 'fixture',
        resultJson: '{}',
        observedAckAt: NOW,
      });
      commitSourceIncidence(store.db, {
        sourceId: external,
        nodeId,
        role: 'extraction',
        currency: 'closed',
        linkId,
        linkVersion: version,
      });
      establishScope(store.db, nodeId, durableRoleScope('extraction', 'out'), NOW);
      establishScope(store.db, external, durableRoleScope('extraction', 'in'), NOW);
    })
    .immediate();
  expect(committedIncidenceForNode(store.db, nodeId)).toEqual([
    expect.objectContaining({ sourceId: external, currency: 'closed', linkVersion: 2 }),
  ]);
  expect(publishedScopeToken(store.db, extractionScope)).not.toBe(extractionBefore);
  expect.soft(verifyEvidenceRevision(store.db, held).status).not.toBe('current');
  const fresh = await chunkTransitionEvidence(
    chunks,
    [{ kind: 'node', id: nodeId, scope: GRAPH_NODE_SCOPE, version: '1' }],
    [member],
    checked.context,
  );
  expect(fresh.readings).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ sourceId: external, reading: 'complete' })]),
  );
});
