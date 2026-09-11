import { expect, it, vi } from 'vitest';

import { revalidateFamilyPolicy } from './family-serving-policy.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import * as family from '../../reflection/application/family-fence.js';
import type { ResolvedEvidenceView } from '../domain/resolved-view.js';
import { item } from '../domain/test-support/pack.fixture.js';

it('replaces the failed snapshot consistently without losing an identity-less candidate issue', () => {
  const store = new SqliteStore({ filePath: ':memory:' });
  const ids = ['a', 'b', 'c'];
  const old = ids.map((id): EvidenceIssue => ({
    address: { kind: 'id', id },
    field: 'representation_preference',
    reason: 'store_unavailable',
    required: true,
  }));
  const untouched: EvidenceIssue = {
    address: { kind: 'id', id: 'fact' },
    field: 'representation_preference',
    reason: 'store_unavailable',
    required: true,
  };
  const view: ResolvedEvidenceView = {
    provenance: new Map(),
    relatedClaims: new Map(),
    ownership: new Map(),
    degraded: new Set(),
    issues: [...old, untouched],
    narrativeFamilies: {
      values: new Map(
        ids.map((id, index) => [
          id,
          {
            family: 'legacy_session_overview' as const,
            sessions: [id],
            selection: 'unknown' as const,
            publication: 'established' as const,
            identity: { nodeId: id, family: 'legacy_session_overview' as const, sessionId: id },
            policyIssues: [old[index]!],
          },
        ]),
      ),
    },
  };
  const original = family.readFamilyFence;
  const read = vi.spyOn(family, 'readFamilyFence').mockImplementation((db, id, at) => {
    if (id === 'b') {
      db.exec('ALTER TABLE family_selection_log RENAME TO held_family_selection_log');
    }
    return original(db, id, at);
  });
  try {
    const result = revalidateFamilyPolicy(store.db, view, checkedContext(), [
      ...ids.map((id) => item(id, { labels: ['Narrative'] })),
      item('fact', { labels: ['Decision'] }),
    ]);
    expect(read.mock.calls.map((call) => call[1])).toEqual(['a', 'b']);
    expect(result.issues).toHaveLength(4);
    expect(result.issues).toContain(untouched);
    for (const issue of old) {
      expect(result.issues).not.toContain(issue);
    }
    for (const id of ids) {
      expect(
        result.issues.filter((issue) => issue.address.kind === 'id' && issue.address.id === id),
      ).toEqual([
        {
          address: { kind: 'id', id },
          field: 'representation_preference',
          reason: 'store_unavailable',
          required: true,
        },
      ]);
    }
    expect(
      store.db.prepare("SELECT name FROM sqlite_master WHERE name='family_selection_log'").get(),
    ).toBeDefined();
  } finally {
    read.mockRestore();
    store.close();
  }
});
