import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { rollUpOverviews } from './overview-rollup.js';
import {
  acceptCorrection,
  acceptSource,
  chunks,
  driver,
  NOW,
  sealFor,
  store,
} from './test-support/t10b-review.fixture.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { walkLineage } from '../../evidence/application/lineage-walk.js';
import { durableRoleScope, NARRATIVE_SCOPES } from '../../evidence/domain/scopes.js';
import { establishScope } from '../../evidence/test-support/evidence.fixture.js';
import { NARRATIVE_PROPERTIES } from '../../infrastructure/graph/narrative-queries.js';
import {
  nodeProperties,
  renameNodeId,
} from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import type { Provider, StructuredRequest } from '../../infrastructure/providers/types.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCitationsFrom } from '../../infrastructure/sqlite/narrative-citations.js';
import {
  CHUNK_REVISION_FAMILY,
  OVERVIEW_REVISION_FAMILY,
  readPublishedRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';

let hook: (() => Promise<void>) | undefined;
let drafted: string[] = [];
const provider: Provider = {
  embed: async () => {
    throw new Error('no embedding');
  },
  generate: async (request: StructuredRequest) => {
    const text = request.messages.map((message) => message.content).join('\n');
    if (text.includes('You review a draft memory')) {
      return { unsupported: false, reason: 'scripted supported output' };
    }
    drafted.push(text);
    const intervene = hook;
    hook = undefined;
    await intervene?.();
    const ids = [...new Set([...text.matchAll(/\[(S\d+)\]/g)].map((match) => match[1]))];
    return {
      sentences: ids.map((id) => ({
        text: 'the overview preserves this source',
        source_ids: [id],
      })),
    };
  },
};
beforeEach(() => {
  hook = undefined;
  drafted = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});
const options = {
  scope: 'day' as const,
  now: NOW,
  windowLimit: 100,
  renderedInputAllowance: 32768,
};

async function published(name: string, day: string) {
  const source = await acceptSource(name, name);
  store.db
    .prepare('UPDATE source_records SET occurred_at = ? WHERE source_id = ?')
    .run(`${day}T12:00:00.000Z`, source);
  const chunk = await sealFor(source);
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  if (result.status !== 'published') {
    throw new Error('fixture chunk did not publish');
  }
  return { source, chunk, nodeId: result.nodeId };
}

it('stores a verifiable overview dependency set and complete recursive lineage', async () => {
  const member = await published('overview-verifiable', '2026-08-01');
  await rollUpOverviews({ ...chunks, provider }, options);
  const head = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-01');
  expect(head).toBeDefined();
  const check = verifyEvidenceRevision(
    store.db,
    JSON.parse(head!.evidenceRevisionJson!) as EvidenceRevision,
  );
  expect.soft(check.status).toBe('current');
  const lineage = walkLineage(store.db, [head!.nodeId], undefined);
  expect.soft(lineage.roots).toContain(member.source);
  expect.soft(lineage.complete).toBe(true);
  // The existing retained-node route works once the author's actual populations are certified.
  for (const scope of [NARRATIVE_SCOPES[0], durableRoleScope('extraction', 'out')]) {
    establishScope(store.db, head!.nodeId, scope, NOW);
  }
  const complete = walkLineage(store.db, [head!.nodeId], undefined);
  expect(complete.roots).toContain(member.source);
  expect(complete.complete).toBe(true);
});

it('refuses or includes a new member arriving while the window is synthesized', async () => {
  await published('overview-before-arrival', '2026-08-02');
  let lateNode: string | undefined;
  hook = async () => {
    lateNode = (await published('overview-during-arrival', '2026-08-02')).nodeId;
  };
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(lateNode).toBeDefined();
  const head = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-02');
  if (head !== undefined) {
    expect(readCitationsFrom(store.db, head.nodeId).map((row) => row.targetId)).toContain(lateNode);
  }
});

it('does not recertify a child whose evidence became stale without a new child revision', async () => {
  const member = await published('overview-stale-child', '2026-08-03');
  await acceptCorrection(
    'overview-child-correction',
    'CORRECTION REQUIRED FOR THIS ACCOUNT',
    member.source,
  );
  const child = readPublishedRevision(store.db, CHUNK_REVISION_FAMILY, member.chunk)!;
  expect(
    verifyEvidenceRevision(store.db, JSON.parse(child.evidenceRevisionJson!) as EvidenceRevision)
      .status,
  ).toBe('stale');
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(
    readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-03'),
  ).toBeUndefined();
});

it('does not allocate another attempt for an unchanged capacity block', async () => {
  await published('overview-capacity-block', '2026-08-04');
  const bounded = { ...options, renderedInputAllowance: 1 };
  await rollUpOverviews({ ...chunks, provider }, bounded);
  const count = () =>
    store.db
      .prepare('SELECT COUNT(*) AS n FROM overview_revisions WHERE family_key = ?')
      .get('day:2026-08-04');
  const before = count();
  drafted = [];
  await rollUpOverviews({ ...chunks, provider }, bounded);
  expect(count()).toEqual(before);
  expect(drafted).toEqual([]);
});

it('can retry after a member-head change without leaving a prepared ghost attempt', async () => {
  const member = await published('overview-head-move', '2026-08-05');
  hook = async () => {
    await acceptCorrection('overview-head-move-correction', 'A CORRECTED CHILD', member.source);
    expect((await publishChunkNarrative(chunks, member.chunk, { now: NOW })).status).toBe(
      'published',
    );
  };
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(
    readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-05'),
  ).toBeUndefined();
  const before = store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM overview_revisions WHERE family_key = ? AND state = 'prepared'",
    )
    .get('day:2026-08-05');
  expect.soft(before).toEqual({ n: 0 });
  await rollUpOverviews({ ...chunks, provider }, options);
  expect
    .soft(readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-05'))
    .toBeDefined();
  expect
    .soft(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM overview_revisions WHERE family_key = ? AND state = 'prepared'",
        )
        .get('day:2026-08-05'),
    )
    .toEqual({ n: 0 });
  expect(chunks.publications.hasPending()).toBe(false);
});

it('control: a readable closed window publishes without superseding its member', async () => {
  const member = await published('overview-current-control', '2026-08-06');
  await rollUpOverviews({ ...chunks, provider }, options);
  const head = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-06')!;
  expect(readCitationsFrom(store.db, head.nodeId).map((row) => row.targetId)).toContain(
    member.nodeId,
  );
  expect((await nodeProperties(driver, member.nodeId)).valid_until).toBeUndefined();
  drafted = [];
  await rollUpOverviews({ ...chunks, provider }, options);
  expect(
    readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-06')?.revisionNo,
  ).toBe(head.revisionNo);
});

it('control: a member with no readable graph body does not publish a whole overview', async () => {
  const member = await published('overview-missing-control', '2026-08-07');
  await renameNodeId(driver, member.nodeId, `${member.nodeId}:hidden`);
  try {
    await rollUpOverviews({ ...chunks, provider }, options);
    expect(
      readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-07'),
    ).toBeUndefined();
  } finally {
    await renameNodeId(driver, `${member.nodeId}:hidden`, member.nodeId);
  }
});

it('keeps coverage membership distinct from the citations the grounded output supports', async () => {
  await published('overview-citation-one', '2026-08-08');
  await published('overview-citation-two', '2026-08-08');
  const oneCitation: Provider = {
    ...provider,
    generate: async (request) => {
      if (
        request.messages.some((message) => message.content.includes('You review a draft memory'))
      ) {
        return { unsupported: false, reason: 'only the first member was cited' };
      }
      return {
        sentences: [{ text: 'the first member supports this statement', source_ids: ['S1'] }],
      };
    },
  };
  await rollUpOverviews({ ...chunks, provider: oneCitation }, options);
  const head = readPublishedRevision(store.db, OVERVIEW_REVISION_FAMILY, 'day:2026-08-08')!;
  expect(head).toBeDefined();
  const node = await nodeProperties(driver, head.nodeId);
  expect(node[NARRATIVE_PROPERTIES.citations]).toHaveLength(1);
  expect(node[NARRATIVE_PROPERTIES.coverageCount]).toBe(2);
  expect(readCitationsFrom(store.db, head.nodeId).map((citation) => citation.targetId)).toEqual(
    node[NARRATIVE_PROPERTIES.citations],
  );
});
