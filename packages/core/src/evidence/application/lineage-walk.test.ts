import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';

import { walkLineage } from './lineage-walk.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  prepareStatedLinkVersion,
  acknowledgeStatedLinkVersions,
  statedLinkId,
  type StatedLinkQualifier,
} from '../../infrastructure/sqlite/evidence-links.js';
import {
  prepareScopeAdvance,
  acknowledgeScopeAdvance,
} from '../../infrastructure/sqlite/evidence-scope.js';
import { readCitationsOf } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  allocateNarrativeRevision,
  publishNarrativeRevision,
  OVERVIEW_REVISION_FAMILY,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import { EVIDENCE_LIMITS, RequestBudget } from '../domain/budget.js';
import {
  seedSource,
  commitIncidence,
  commitSourceState,
  establishScope,
} from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');
const LATER = new Date('2026-09-08T11:00:00.000Z');
let dir: string;
let store: SqliteStore;
function source(id: string) {
  seedSource(store.db, {
    sourceId: id,
    sessionId: 'session',
    identity: 'review',
    content: { turns: [{ role: 'user', text: id }] },
    turnIds: [`${id}-turn`],
    now: NOW,
  });
  establishScope(store.db, id, 'sqlite:stated_derivation:out', NOW);
}
function derive(
  from: string,
  to: string,
  op: string,
  qualifier: StatedLinkQualifier = 'source',
  at = NOW,
) {
  store.db
    .transaction(() => {
      commitSourceState(store.db, {
        sourceId: from,
        stateKind: 'unforgotten',
        operationId: op,
        at,
      });
      prepareStatedLinkVersion(store.db, {
        linkId: statedLinkId('derived_from', qualifier, from, to),
        kind: 'derived_from',
        qualifier,
        fromId: from,
        toId: to,
        operationId: op,
        operationKey: op,
        recordedValues: {},
        temporalProof: {},
        observedAt: at,
        referenceSourceId: from,
        referenceVersion: 1,
      });
      acknowledgeStatedLinkVersions(store.db, op, at.toISOString(), at.toISOString());
      prepareScopeAdvance(store.db, {
        endpointId: from,
        relationClass: 'sqlite:stated_derivation:out',
        operationId: op,
        updatedAt: at,
      });
      acknowledgeScopeAdvance(store.db, {
        endpointId: from,
        relationClass: 'sqlite:stated_derivation:out',
        operationId: op,
        updatedAt: at,
        censusStatus: 'established',
      });
    })
    .immediate();
}
function publish(key: string, targetId: string, targetKind = 'source', at = NOW) {
  const allocated = allocateNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, key, at);
  store.db
    .transaction(() => {
      const op = `publish-${allocated.nodeId}`;
      commitSourceState(store.db, {
        sourceId: 'left',
        stateKind: 'unforgotten',
        operationId: op,
        at,
      });
      publishNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, {
        familyKey: key,
        revisionNo: allocated.revisionNo,
        operationId: op,
        evidenceRevisionJson: '{}',
        knownFrom: at.toISOString(),
        observedAckAt: at.toISOString(),
        publishedAt: at,
      });
      store.db
        .prepare(
          'INSERT INTO revision_citations(narrative_node_id,target_id,target_kind) VALUES (?,?,?)',
        )
        .run(allocated.nodeId, targetId, targetKind);
    })
    .immediate();
  establishScope(store.db, allocated.nodeId, 'sqlite:extraction:out', at);
  establishScope(store.db, allocated.nodeId, 'sqlite.revision_citations', at);
  return allocated.nodeId;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 't5-fix3-review-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  for (const id of ['left', 'right', 'root']) {
    source(id);
  }
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
it('crosses two published narrative revisions to their cited source', () => {
  const inner = publish('inner', 'root');
  const outer = publish('outer', inner, 'retained_node');
  derive('left', outer, 'through-outer', 'retained_node');
  expect(walkLineage(store.db, ['left'], undefined)).toMatchObject({
    roots: ['root'],
    complete: true,
  });
});
it('retains citation and ancestry evidence at a vantage before the revision was closed', () => {
  const first = publish('week', 'root');
  derive('left', first, 'through-first', 'retained_node');
  publish('week', 'right', 'source', LATER);
  const at = new Date('2026-09-08T10:30:00.000Z');
  expect
    .soft(readCitationsOf(store.db, 'root', at).map((row) => row.narrativeNodeId))
    .toEqual([first]);
  expect.soft(walkLineage(store.db, ['left'], at).roots).toEqual(['root']);
});
it('keeps the root reachable through a shorter path after the longer path hit the hop bound', () => {
  for (const id of ['a', 'b', 'c', 'd']) {
    source(id);
  }
  derive('left', 'a', 'l-a');
  derive('a', 'b', 'a-b');
  derive('b', 'c', 'b-c');
  derive('c', 'd', 'c-d');
  derive('d', 'root', 'd-root');
  derive('right', 'd', 'r-d');
  const result = walkLineage(store.db, ['left', 'right'], undefined);
  expect.soft(result.complete).toBe(false);
  expect.soft(result.roots).toEqual(['root']);
});
it('charges the historical frontier population rather than its vanished current projection', () => {
  source('third-root');
  derive('left', 'retained', 'to-retained', 'retained_node');
  for (const id of ['root', 'right', 'third-root']) {
    commitIncidence(store.db, {
      sourceId: id,
      nodeId: 'retained',
      role: 'extraction',
      operationId: `extract-${id}`,
      at: NOW,
    });
  }
  establishScope(store.db, 'retained', 'sqlite:extraction:out', NOW);
  store.db.prepare("DELETE FROM source_incidence WHERE node_id='retained'").run();
  const result = walkLineage(
    store.db,
    ['left'],
    NOW,
    new RequestBudget({ ...EVIDENCE_LIMITS, relationRows: 2 }),
  );
  expect(result.complete).toBe(false);
});
it('keeps a still-open unresolved declaration incomplete when a second qualified declaration exists', () => {
  derive('left', 'late-source', 'unknown-link', 'unresolved', NOW);
  source('late-source');
  derive('left', 'late-source', 'known-link', 'source', LATER);
  expect(walkLineage(store.db, ['left'], undefined)).toMatchObject({
    roots: ['late-source'],
    complete: false,
  });
});
