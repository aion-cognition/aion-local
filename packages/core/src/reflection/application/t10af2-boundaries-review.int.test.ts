import { afterEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import {
  acceptCorrection,
  acceptSource,
  chunks,
  driver,
  NOW,
  onGenerate,
  prompts,
  sealFor,
  store,
} from './test-support/t10a-review.fixture.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import {
  commitIncidence,
  establishNodeState,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';
import * as narrativeQueries from '../../infrastructure/graph/narrative-queries.js';
import { nodeProperties } from '../../infrastructure/graph/test-support/graph-queries.fixture.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it.each([true, false])(
  'certifies enrichment only across an unchanged interval (rewrite=%s)',
  async (rewrite) => {
    const source = await acceptSource(`real-enrichment-rewrite:${String(rewrite)}`, 'MEMBER');
    const id = `review-real-enrichment-rewrite:${String(rewrite)}`;
    await writeStampedNode(driver, {
      label: 'Insight',
      id,
      now: NOW,
      properties: { text: 'OLD TRUE TEXT' },
    });
    await upsertEdge(driver, {
      type: 'EXTRACTED_FROM',
      sourceId: id,
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
      nodeId: id,
      role: 'extraction',
      operationId: `${id}:incidence`,
      at: NOW,
    });
    for (const { role, direction } of OWNERSHIP_SCOPES) {
      establishScope(store.db, id, durableRoleScope(role, direction), NOW);
    }
    establishNodeState(store.db, id, { revision: 1, at: NOW });
    const chunk = await sealFor(source);
    const original = narrativeQueries.loadMemberSourceNodes;
    let moved = false;
    vi.spyOn(narrativeQueries, 'loadMemberSourceNodes').mockImplementation(async (...args) => {
      const rows = await original(...args);
      if (rewrite && !moved && rows.some((row) => row.id === id)) {
        moved = true;
        expect(rows.find((row) => row.id === id)?.text).toBe('OLD TRUE TEXT');
        await writeStampedNode(driver, {
          label: 'Insight',
          id,
          now: NOW,
          properties: {},
          mergeProperties: { text: 'NEW TRUE TEXT' },
        });
        expect((await nodeProperties(driver, id)).text).toBe('NEW TRUE TEXT');
        establishNodeState(store.db, id, { revision: 2, at: NOW });
      }
      return rows;
    });
    const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
    expect(moved).toBe(rewrite);
    if (rewrite && result.status === 'published') {
      expect(prompts.every((prompt) => !prompt.includes('OLD TRUE TEXT'))).toBe(true);
    }
    if (!rewrite) {
      expect(result.status).toBe('published');
      expect(prompts.at(-1)).toContain('OLD TRUE TEXT');
    }
  },
);

it('does not certify a transitive requirement discovered before its negative-read token', async () => {
  const member = await acceptSource('transition-read-window', 'BASE MEMBER');
  const direct = await acceptCorrection('transition-direct', 'DIRECT REQUIRED TEXT', member);
  const chunk = await sealFor(member);
  const original = chunks.resolver.resolveSources.bind(chunks.resolver);
  let moved = false;
  vi.spyOn(chunks.resolver, 'resolveSources').mockImplementation(async (...args) => {
    if (!moved && JSON.stringify(args[0]).includes(direct)) {
      moved = true;
      await acceptCorrection('late-refinement', 'REFINEMENT INSERTED DURING READ', direct);
    }
    return original(...args);
  });
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(moved).toBe(true);
  if (result.status === 'published') {
    expect(prompts.at(-1)).toContain('REFINEMENT INSERTED DURING READ');
  }
});

it('does not certify an external requirement whose incoming census is unknown', async () => {
  const member = await acceptSource('unknown-transitive-census', 'BASE MEMBER');
  const direct = await acceptCorrection('unknown-direct', 'DIRECT REQUIREMENT', member);
  const chunk = await sealFor(member);
  store.db
    .prepare(
      "UPDATE evidence_scope_versions SET census_status = 'unknown' WHERE endpoint_id = ? AND relation_class = ?",
    )
    .run(direct, durableRoleScope('stated_correction', 'in'));
  expect(
    store.db
      .prepare(
        'SELECT census_status FROM evidence_scope_versions WHERE endpoint_id = ? AND relation_class = ?',
      )
      .get(direct, durableRoleScope('stated_correction', 'in')),
  ).toEqual({ census_status: 'unknown' });
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(result.status).not.toBe('published');
});

it('fences a returning old claimant after its pre-intent lease has been reclaimed', async () => {
  const member = await acceptSource('expired-claim-race', 'SOURCE UNDER TWO CLAIMANTS');
  const chunk = await sealFor(member);
  let entered!: () => void;
  let release!: () => void;
  const atFirst = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const holdFirst = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  onGenerate(async () => {
    calls += 1;
    if (calls === 1) {
      entered();
      await holdFirst;
      return { sentences: [{ text: 'old actor wording', source_ids: ['S1'] }] };
    }
    return { sentences: [{ text: 'new actor wording', source_ids: ['S1'] }] };
  });
  const first = publishChunkNarrative(chunks, chunk, { now: NOW }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await atFirst;
  const lease = store.db
    .prepare('SELECT claim_expires_at FROM chunk_revisions WHERE chunk_id = ? AND revision_no = 1')
    .get(chunk) as { claim_expires_at: string };
  const later = new Date(new Date(lease.claim_expires_at).getTime() + 1);
  const secondStore = new SqliteStore({ filePath: store.db.name });
  const secondLogger = openLogger({ filePath: '/dev/null', level: 'fatal' });
  const secondPublications = new PublicationCoordinator({
    db: secondStore.db,
    driver,
    logger: secondLogger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => NOW,
  });
  let second: unknown;
  try {
    await secondPublications.initialize();
    const secondDeps = {
      ...chunks,
      db: secondStore.db,
      publications: secondPublications,
      resolver: new EvidenceResolver({
        db: secondStore.db,
        driver,
        publications: secondPublications,
        logger: chunks.logger,
      }),
    };
    second = await publishChunkNarrative(secondDeps, chunk, { now: later }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  } finally {
    release();
    await first;
    secondStore.close();
  }
  expect.soft(second).not.toHaveProperty('error');
  expect.soft(await first).not.toHaveProperty('error');
  expect(chunks.publications.hasPending()).toBe(false);
});
