import { expect, it } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
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
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import {
  commitIncidence,
  establishNodeState,
  establishScope,
} from '../../evidence/test-support/evidence.fixture.js';
import { writeStampedNode } from '../../infrastructure/graph/bitemporal.js';
import { upsertEdge } from '../../infrastructure/graph/edges.js';

async function enrichment(source: string, id: string, text: string, proved = true): Promise<void> {
  await writeStampedNode(driver, { label: 'Insight', id, now: NOW, properties: { text } });
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
  if (proved) {
    commitIncidence(store.db, {
      sourceId: source,
      nodeId: id,
      role: 'extraction',
      operationId: `extract:${id}`,
      at: NOW,
    });
    for (const { role, direction } of OWNERSHIP_SCOPES) {
      establishScope(store.db, id, durableRoleScope(role, direction), NOW);
    }
    establishNodeState(store.db, id, { revision: 1, at: NOW });
  }
}

it('keeps the first applicable correction when a second member is corrected later', async () => {
  const first = await acceptSource('two-corrections', 'first original statement');
  const second = await acceptSource('two-corrections', 'second original statement');
  const chunk = await sealFor(first);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  await acceptCorrection('corrector-one', 'FIRST CURRENT CORRECTION', first);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  expect(prompts.at(-1)).toContain('FIRST CURRENT CORRECTION');
  await acceptCorrection('corrector-two', 'SECOND CURRENT CORRECTION', second);
  const latest = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(latest.status).toBe('published');
  expect.soft(prompts.at(-1)).toContain('FIRST CURRENT CORRECTION');
  expect.soft(prompts.at(-1)).toContain('SECOND CURRENT CORRECTION');
});

it('does not publish on stale enrichment that was present in the submitted input', async () => {
  const source = await acceptSource('enrichment-race', 'raw enrichment source');
  const id = 'review-enrichment-node';
  await enrichment(source, id, 'OLD ENRICHMENT READING');
  const chunk = await sealFor(source);
  onGenerate(async () => {
    await writeStampedNode(driver, {
      label: 'Insight',
      id,
      now: NOW,
      properties: { text: 'NEW ENRICHMENT READING' },
    });
    establishNodeState(store.db, id, { revision: 2, at: NOW });
    return { sentences: [{ text: 'the enrichment was the conclusion', source_ids: ['S2'] }] };
  });
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(prompts).toHaveLength(1);
  if (prompts[0]?.includes('OLD ENRICHMENT READING')) {
    expect(result.status).not.toBe('published');
  } else {
    // Omission is safe when the optional enrichment cannot be certified.
    expect(prompts[0]).toContain('raw enrichment source');
  }
});

it('restricts enrichment to the chunk before a session-wide cap can hide its candidates', async () => {
  const old = await acceptSource(
    'enrichment-window',
    'older source',
    true,
    new Date(NOW.getTime() - 3600000),
  );
  await sealFor(old);
  for (let index = 0; index < 120; index += 1) {
    await enrichment(old, `older-node-${String(index)}`, `old insight ${String(index)}`, false);
  }
  const current = await acceptSource('enrichment-window', 'newer source');
  await enrichment(current, 'current-enrichment-node', 'CURRENT CHUNK ENRICHMENT');
  const chunk = await sealFor(current);
  expect((await publishChunkNarrative(chunks, chunk, { now: NOW })).status).toBe('published');
  expect(prompts.at(-1)).toContain('newer source');
  expect(prompts.at(-1)).toContain('CURRENT CHUNK ENRICHMENT');
});

it('includes an applicable correction that predates the first narrative publication', async () => {
  const source = await acceptSource('already-corrected-source', 'original statement');
  await acceptCorrection('already-corrected-caller', 'CORRECTION BEFORE FIRST HEAD', source);
  const chunk = await sealFor(source);
  const result = await publishChunkNarrative(chunks, chunk, { now: NOW });
  expect(result.status).toBe('published');
  expect(prompts.at(-1)).toContain('CORRECTION BEFORE FIRST HEAD');
});
