import { afterEach, expect, it, vi } from 'vitest';

import { publishChunkNarrative } from './chunk-narrative.js';
import {
  acceptCorrection,
  acceptSource,
  chunks,
  NOW,
  onGenerate,
  sealFor,
  store,
} from './test-support/t10a-review.fixture.js';
import { listAllocatedRevisions } from '../../infrastructure/sqlite/narrative-allocations.js';
import {
  allocateNarrativeRevision,
  CHUNK_REVISION_FAMILY,
  deferRevisionAttempt,
  readNarrativeRevision,
} from '../../infrastructure/sqlite/narrative-revisions.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {
    throw new Error('gate not initialized');
  };
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function sentence(text: string): unknown {
  return { sentences: [{ text, source_ids: ['S1'] }] };
}

it.each([false, true])('does not share a live pre-intent allocation (retry=%s)', async (retry) => {
  const source = await acceptSource(`allocation-owner-race:${String(retry)}`, 'A SHARED SOURCE');
  const chunkId = await sealFor(source);
  if (retry) {
    onGenerate(() => {
      throw new Error('initial scripted failure');
    });
    expect((await publishChunkNarrative(chunks, chunkId, { now: NOW })).status).toBe('failed');
  }
  const firstEntered = gate();
  const secondEntered = gate();
  const release = gate();
  let calls = 0;
  let secondAllocationCount = 0;
  onGenerate(async () => {
    calls += 1;
    if (calls === 1) {
      firstEntered.open();
      await release.promise;
      return sentence('first valid wording');
    }
    secondAllocationCount = listAllocatedRevisions(store.db, CHUNK_REVISION_FAMILY, chunkId).length;
    secondEntered.open();
    return sentence('second valid wording');
  });
  const first = publishChunkNarrative(chunks, chunkId, { now: NOW }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await firstEntered.promise;
  const second = publishChunkNarrative(chunks, chunkId, { now: NOW }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  try {
    // A competing caller may decline before synthesis, or use a different allocation. It may
    // not start a second provider call under the first call's unbound number.
    await Promise.race([secondEntered.promise, second.then(() => undefined)]);
    if (calls > 1) {
      expect.soft(secondAllocationCount).toBeGreaterThanOrEqual(2);
    }
  } finally {
    release.open();
  }
  const outcomes = await Promise.all([first, second]);
  for (const outcome of outcomes) {
    expect.soft(outcome).not.toHaveProperty('error');
  }
});

it('takes the due allocation instead of an older allocation whose retry time has not arrived', async () => {
  const source = await acceptSource('allocation-due-row', 'A RETRY SOURCE');
  const chunkId = await sealFor(source);
  onGenerate(() => {
    throw new Error('scripted provider failure');
  });
  const failed = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  if (failed.status !== 'failed') {
    throw new Error('fixture did not leave a failed pre-intent row');
  }
  deferRevisionAttempt(
    store.db,
    CHUNK_REVISION_FAMILY,
    chunkId,
    failed.revisionNo,
    new Date(NOW.getTime() + 3600000),
  );
  const due = allocateNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, NOW);
  onGenerate(() => undefined);
  const result = await publishChunkNarrative(chunks, chunkId, { now: NOW });
  expect(result.status).toBe('published');
  if (result.status === 'published') {
    expect(result.revisionNo).toBe(due.revisionNo);
  }
});

it('does not abandon a newer allocation when an older acknowledged caller returns late', async () => {
  const source = await acceptSource('late-allocation-cleanup', 'A SOURCE WITH LATER CORRECTION');
  const chunkId = await sealFor(source);
  const acknowledged = gate();
  const returnFirst = gate();
  const secondModel = gate();
  const returnSecond = gate();
  const original = chunks.publications.publish.bind(chunks.publications);
  let intercepted = false;
  vi.spyOn(chunks.publications, 'publish').mockImplementation(async (...args) => {
    const outcome = await original(...args);
    if (!intercepted && args[0].kind === 'narrative_publish' && outcome.status === 'acknowledged') {
      intercepted = true;
      acknowledged.open();
      await returnFirst.promise;
    }
    return outcome;
  });
  let calls = 0;
  onGenerate(async () => {
    calls += 1;
    if (calls === 2) {
      secondModel.open();
      await returnSecond.promise;
    }
  });
  const first = publishChunkNarrative(chunks, chunkId, { now: NOW }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await acknowledged.promise;
  await acceptCorrection('later-valid-correction', 'LATER VALID CORRECTION', source);
  const second = publishChunkNarrative(chunks, chunkId, { now: NOW }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await secondModel.promise;
  const row = listAllocatedRevisions(store.db, CHUNK_REVISION_FAMILY, chunkId)[0];
  expect(row).toBeDefined();
  try {
    returnFirst.open();
    expect(await first).not.toHaveProperty('error');
    expect
      .soft(readNarrativeRevision(store.db, CHUNK_REVISION_FAMILY, chunkId, row!.revisionNo)?.state)
      .toBe('allocated');
  } finally {
    returnFirst.open();
    returnSecond.open();
  }
  expect.soft(await second).not.toHaveProperty('error');
  expect.soft(chunks.publications.hasPending()).toBe(false);
  const recovery = await chunks.publications.recover().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  expect.soft(recovery).not.toHaveProperty('error');
});
