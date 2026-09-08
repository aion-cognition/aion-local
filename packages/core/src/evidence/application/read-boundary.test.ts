import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { durableLineage } from './durable-lineage.js';
import type { JudgmentPair } from './judgment.js';
import { EvidenceResolver } from './resolver.js';
import { knewAt } from '../../infrastructure/graph/read-modes.js';
import type { CheckpointResult } from '../../infrastructure/publication/types.js';
import {
  committedIncidenceForNode,
  committedIncidenceForNodesAt,
  committedLinkVersionAt,
} from '../../infrastructure/sqlite/committed-evidence.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import * as links from '../../infrastructure/sqlite/evidence-links.js';
import { recordScopeMirror } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  allocateNarrativeRevision,
  OVERVIEW_REVISION_FAMILY,
  publishNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';
import * as publicationStore from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { idAddress } from '../domain/address.js';
import { EVIDENCE_LIMITS, RequestBudget } from '../domain/budget.js';
import { GRAPH_NODE_SCOPE } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
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

function derive(from: string, to: string, operationId: string): void {
  store.db
    .transaction(() => {
      commitSourceState(store.db, {
        sourceId: from,
        stateKind: 'unforgotten',
        operationId,
        at: NOW,
      });
      links.prepareStatedLinkVersion(store.db, {
        linkId: links.statedLinkId('derived_from', 'source', from, to),
        kind: 'derived_from',
        qualifier: 'source',
        fromId: from,
        toId: to,
        operationId,
        operationKey: operationId,
        recordedValues: {},
        temporalProof: {},
        observedAt: NOW,
        referenceSourceId: from,
        referenceVersion: 1,
      });
      links.acknowledgeStatedLinkVersions(
        store.db,
        operationId,
        NOW.toISOString(),
        NOW.toISOString(),
      );
    })
    .immediate();
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

it('can derive old incidence from the preserved chain after its current row is removed', () => {
  expect(committedLinkVersionAt(store.db, 'left:old:extraction', NOW)?.version).toBe(1);
  store.db.prepare("DELETE FROM source_incidence WHERE source_id='left' AND node_id='old'").run();
  expect(
    committedIncidenceForNodesAt(store.db, ['old'], NOW, 'extraction').map((row) => row.sourceId),
  ).toEqual(['left']);
});

it('keeps a source-state snapshot local when another request indexes the same source', async () => {
  vi.spyOn(publicationStore, 'pendingPublicationKind').mockReturnValue('episode_eviction');
  let release: (value: CheckpointResult) => void = () => undefined;
  let reached: () => void = () => undefined;
  const secondRead = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const delayed = new Promise<CheckpointResult>((resolve) => {
    release = resolve;
  });
  let count = 0;
  const r = resolver(() => {
    count++;
    if (count === 2) {
      reached();
      return delayed;
    }
    return Promise.resolve(ready('2'));
  });
  const first = r.resolveSources([idAddress('left')], checkedContext(), 'raw_inspection');
  await secondRead;
  commitSourceState(store.db, {
    sourceId: 'left',
    stateKind: 'forgotten',
    operationId: 'forgot-in-between',
    at: NOW,
  });
  await r.resolveSources([idAddress('left')], checkedContext(), 'search_indexing');
  release({ status: 'unavailable', reason: 'pending_publication' });
  const result = await first;
  expect(result.results.get(JSON.stringify(['id', 'left']))?.evidence.status).not.toBe(
    'complete-for-use',
  );
});

it('does not borrow the raw exception after mapping verification was withdrawn', async () => {
  vi.spyOn(publicationStore, 'pendingPublicationKind').mockReturnValue('episode_eviction');
  let count = 0;
  const r = resolver(async () => {
    count++;
    if (count === 2) {
      store.db
        .prepare(
          "UPDATE source_records SET verification_status='pinned', verification_reason='mapping withdrawn' WHERE source_id='left'",
        )
        .run();
      return { status: 'unavailable', reason: 'pending_publication' };
    }
    return ready();
  });
  const result = await r.resolveSources([idAddress('left')], checkedContext(), 'raw_inspection');
  expect(result.results.get(JSON.stringify(['id', 'left']))?.evidence.status).not.toBe(
    'complete-for-use',
  );
});

it('treats shared-parent convergence as complete rather than a cycle', () => {
  derive('left', 'root', 'left-parent');
  derive('right', 'root', 'right-parent');
  commitIncidence(store.db, {
    sourceId: 'right',
    nodeId: 'old',
    role: 'extraction',
    operationId: 'right-origin',
    at: NOW,
  });
  const result = durableLineage(
    store.db,
    'old',
    committedIncidenceForNode(store.db, 'old', 'extraction'),
    undefined,
  );
  expect.soft(result.roots).toEqual(['root']);
  expect.soft(result.complete).toBe(true);
});

it('does not borrow extraction census as proof of an empty citation set', async () => {
  const batch = await resolver().resolveMetadata(['old'], checkedContext(), { maxRoots: 4 });
  expect(batch.results.get(JSON.stringify(['id', 'old']))?.value?.narrativeBinding).toEqual({
    status: 'unavailable',
  });
});

it('does not expose a later published citation at an earlier knowledge vantage', async () => {
  const later = new Date('2026-09-08T11:00:00.000Z');
  const allocated = allocateNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, 'week', NOW);
  store.db
    .transaction(() => {
      commitSourceState(store.db, {
        sourceId: 'left',
        stateKind: 'unforgotten',
        operationId: 'publish-overview',
        at: later,
      });
      publishNarrativeRevision(store.db, OVERVIEW_REVISION_FAMILY, {
        familyKey: 'week',
        revisionNo: allocated.revisionNo,
        operationId: 'publish-overview',
        evidenceRevisionJson: '{}',
        knownFrom: later.toISOString(),
        observedAckAt: later.toISOString(),
        publishedAt: later,
      });
      store.db
        .prepare(
          'INSERT INTO revision_citations(narrative_node_id,target_id,target_kind) VALUES (?,?,?)',
        )
        .run(allocated.nodeId, 'old', 'retained_node');
    })
    .immediate();
  const batch = await resolver().resolveMetadata(
    ['old'],
    checkedContext({ mode: knewAt(new Date('2026-09-08T10:30:00.000Z')) }),
    { maxRoots: 4 },
  );
  expect(batch.results.get(JSON.stringify(['id', 'old']))?.value?.narrativeBinding.status).not.toBe(
    'cited',
  );
});

it('does not materialize a parent fanout beyond the remaining relation budget', async () => {
  for (let i = 0; i < 5; i++) {
    source(`parent-${String(i)}`);
    derive('left', `parent-${String(i)}`, `parent-link-${String(i)}`);
  }
  const original = links.listStatedLinks;
  let returned = 0;
  vi.spyOn(links, 'listStatedLinks').mockImplementation((db, id) => {
    const rows = original(db, id);
    returned += rows.length;
    return rows;
  });
  await resolver().resolveMetadata(['old'], checkedContext(), {
    maxRoots: 10,
    budget: new RequestBudget({ ...EVIDENCE_LIMITS, relationRows: 2 }),
  });
  expect(returned).toBeLessThanOrEqual(2);
});
