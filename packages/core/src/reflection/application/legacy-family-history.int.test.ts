import { beforeEach, expect, it } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { ensureSessionFamily, inventoryLegacyNarrative } from './narrative-family.js';
import {
  acceptSource,
  chunks,
  driver,
  NOW,
  sessionOf,
  store,
} from './test-support/t10b-review.fixture.js';
import { verifyEvidenceRevision } from '../../evidence/application/dependencies.js';
import { readNarrativeRepresentations } from '../../evidence/application/narrative-representation.js';
import { RequestBudget } from '../../evidence/domain/budget.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
import { seedLegacyFamilyVersion } from '../../infrastructure/graph/test-support/family-cutover.fixture.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readLegacyNarrative } from '../../infrastructure/sqlite/legacy-narratives.js';

let counter = 0;
let sessionId: string;
let legacyId: string;
let clock: Date;
let knownAt: Date;
let publications: PublicationCoordinator;
beforeEach(async () => {
  counter += 1;
  const id = await acceptSource(`old-knowledge-${counter}`, 'original source', false);
  sessionId = sessionOf(id);
  legacyId = `old-knowledge-narrative-${counter}`;
  await seedLegacyFamilyVersion(driver, { nodeId: legacyId, sessionId, sources: [id], now: NOW });
  knownAt = new Date(NOW.getTime() + counter * 10000);
  clock = new Date(knownAt.getTime() + 1000);
  publications = new PublicationCoordinator({
    driver,
    db: store.db,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    logger: { warn: () => undefined, error: () => undefined },
    now: () => clock,
  });
  await publications.initialize();
  expect((await ensureSessionFamily({ ...chunks, publications }, sessionId)).status).toBe('ready');
  clock = new Date(knownAt.getTime() + 2000);
  expect(
    (
      await inventoryLegacyNarrative(
        { ...chunks, publications },
        { sessionId, narrativeId: legacyId },
      )
    ).status,
  ).toBe('acknowledged');
});

it('uses copied publication knowledge before initialization without relabeling inventory arrival', async () => {
  const original = readLegacyNarrative(store.db, legacyId)!;
  const copied = JSON.parse(original.originalPublicationJson ?? '{}') as {
    knownFrom?: string;
    basis?: string;
  };
  expect(copied).toMatchObject({ knownFrom: NOW.toISOString(), basis: 'graph_tx_from' });
  expect(original.publication).toBeUndefined();
  expect(
    store.db
      .prepare('SELECT created_at FROM legacy_narratives WHERE narrative_id = ?')
      .get(legacyId),
  ).toEqual({ created_at: clock.toISOString() });
  for (const mode of [{ knownAt }, { knownAt, validAt: new Date(NOW.getTime() - 60000) }]) {
    const view = await readNarrativeRepresentations(
      { driver, db: store.db },
      [legacyId],
      checkedContext({ mode, now: clock }),
      new RequestBudget(),
    );
    expect(view.values.get(legacyId)).toMatchObject({
      selection: 'selected',
      publication: 'established',
    });
    expect(view.issues).toEqual([]);
    expect(view.dependencies.length).toBeGreaterThan(0);
    await inventoryLegacyNarrative(
      { ...chunks, publications },
      { sessionId, narrativeId: legacyId },
    );
    expect(verifyEvidenceRevision(store.db, buildEvidenceRevision(view.dependencies)).status).toBe(
      'stale',
    );
  }
  const afterInit = await readNarrativeRepresentations(
    { driver, db: store.db },
    [legacyId],
    checkedContext({ mode: { knownAt: new Date(knownAt.getTime() + 1500) }, now: clock }),
    new RequestBudget(),
  );
  expect(afterInit.values.get(legacyId)?.selection).toBe('selected');
});

it.each(['absent', 'malformed'] as const)(
  'discloses %s original publication knowledge rather than dating it to inventory',
  async (mode) => {
    store.db
      .prepare('UPDATE legacy_narratives SET original_publication_json = ? WHERE narrative_id = ?')
      .run(
        mode === 'absent'
          ? null
          : JSON.stringify({
              knownFrom: 'yesterday',
              basis: 'graph_tx_from',
              recordedBy: 'anything',
            }),
        legacyId,
      );
    const view = await readNarrativeRepresentations(
      { driver, db: store.db },
      [legacyId],
      checkedContext({ mode: { knownAt }, now: clock }),
      new RequestBudget(),
    );
    expect(view.values.get(legacyId)?.publication).toBe('unknown');
    expect(view.issues).toContainEqual(
      expect.objectContaining({
        field: 'narrative_revision',
        reason: 'unsupported_history',
        historyReason: 'not_recorded',
        required: true,
      }),
    );
  },
);

it('does not infer old legacy preference when the first recorded choice is chunks', async () => {
  const source = await acceptSource(
    `first-chunk-${counter}`,
    'a session first initialized without legacy history',
    false,
  );
  const otherSession = sessionOf(source);
  const first = await ensureSessionFamily({ ...chunks, publications }, otherSession);
  expect(first.status === 'ready' ? first.reading.selection.family : first.reason).toBe('chunk');
  const otherLegacy = `late-inventory-${counter}`;
  await seedLegacyFamilyVersion(driver, {
    nodeId: otherLegacy,
    sessionId: otherSession,
    sources: [source],
    now: NOW,
  });
  expect(
    (
      await inventoryLegacyNarrative(
        { ...chunks, publications },
        { sessionId: otherSession, narrativeId: otherLegacy },
      )
    ).status,
  ).toBe('acknowledged');
  const view = await readNarrativeRepresentations(
    { driver, db: store.db },
    [otherLegacy],
    checkedContext({ mode: { knownAt }, now: clock }),
    new RequestBudget(),
  );
  expect(view.values.get(otherLegacy)?.selection).toBe('unknown');
  expect(view.issues).toContainEqual(
    expect.objectContaining({ field: 'representation_preference', reason: 'unsupported_history' }),
  );
});

it('excludes a legacy publication not yet known at the pinned knowledge time', async () => {
  const view = await readNarrativeRepresentations(
    { driver, db: store.db },
    [legacyId],
    checkedContext({ mode: { knownAt: new Date(NOW.getTime() - 1000) }, now: clock }),
    new RequestBudget(),
  );
  expect(view.values.get(legacyId)).toMatchObject({
    selection: 'not_selected',
    knownAtVantage: false,
  });
});
