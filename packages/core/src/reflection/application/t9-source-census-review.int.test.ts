import { expect, it } from 'vitest';

import { incomingStatementScopes, memberScopesCounted } from './chunk-evidence.js';
import { acceptCorrection, acceptSource, store } from './test-support/t10b-review.fixture.js';
import { OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope } from '../../evidence/domain/scopes.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';

/**
 * The steady-state half of the acceptance census: what an ordinary push leaves countable, without
 * a fixture seeding anything. The migration case proves the same producer on the historical path.
 */

const CORRECTION = durableRoleScope('stated_correction', 'in');
const CONFIRMATION = durableRoleScope('stated_confirmation', 'in');

/** Every scope row an endpoint carries, with what each says about its census. */
function scopeRows(sourceId: string): Record<string, string> {
  const rows = store.db
    .prepare(
      'SELECT relation_class, census_status FROM evidence_scope_versions WHERE endpoint_id = ?',
    )
    .all(sourceId) as { relation_class: string; census_status: string }[];
  return Object.fromEntries(rows.map((row) => [row.relation_class, row.census_status]));
}

it('counts a fresh source incoming-statement populations at the acceptance that mints it', async () => {
  const source = await acceptSource('steady-state-census', 'a plain acceptance', false);

  expect(memberScopesCounted(store.db, [source])).toBe(true);
  const reading = incomingStatementScopes(store.db, source);
  expect(reading.unproved).toEqual([]);
  expect(reading.dependencies.map((entry) => entry.scope).sort()).toEqual(
    [CONFIRMATION, CORRECTION].sort(),
  );
});

it('counts those populations and nothing else it did not enumerate', async () => {
  const source = await acceptSource('census-reach', 'an acceptance with no statements', false);

  // Two questions about the same minted id: what could have been STATED about it as a source, and
  // what could have been RECORDED about it as a node. Every other scope stays ABSENT rather than
  // counted-empty, because this acceptance enumerated only the populations nothing could have
  // written to yet, not the ones a later pass owns.
  expect(scopeRows(source)).toEqual({
    [CORRECTION]: 'established',
    [CONFIRMATION]: 'established',
    ...Object.fromEntries(
      OWNERSHIP_SCOPES.map(({ role, direction }) => [
        durableRoleScope(role, direction),
        'established',
      ]),
    ),
  });
});

it('keeps the count covering the population when a statement arrives, and moves the token', async () => {
  const source = await acceptSource('census-then-correction', 'the corrected source', false);
  const before = readScopeVersion(store.db, {
    endpointId: source,
    relationClass: CORRECTION,
  })?.publishedRevision;

  await acceptCorrection('census-correction', 'the later correction', source);

  const after = readScopeVersion(store.db, { endpointId: source, relationClass: CORRECTION });
  // The statement writer advances the same counter in the transaction that records it, so the
  // census keeps covering the population while every reader holding the old token finds out.
  expect(after?.censusStatus).toBe('established');
  expect(after?.publishedRevision).toBeGreaterThan(before ?? 0);
});

it('counts nothing for a push that resolves to a source the records already hold', async () => {
  const source = await acceptSource('census-duplicate', 'the re-pushed experience', false);
  const minted = readScopeVersion(store.db, {
    endpointId: source,
    relationClass: CONFIRMATION,
  })?.publishedRevision;

  const again = await acceptSource('census-duplicate', 'the re-pushed experience', false);

  expect(again).toBe(source);
  // A reused occurrence enumerated nothing about this source. Counting again here would publish a
  // number for a population this acceptance never looked at.
  expect(
    readScopeVersion(store.db, { endpointId: source, relationClass: CONFIRMATION })
      ?.publishedRevision,
  ).toBe(minted);
});
