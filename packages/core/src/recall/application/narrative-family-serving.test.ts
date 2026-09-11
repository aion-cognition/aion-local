import { expect, it, vi } from 'vitest';

import { discloseFamilyGaps, revalidateFamilyPolicy } from './family-serving-policy.js';
import { serveFrom, type ServingAssembly } from './serving-assembly.js';
import * as representations from '../../evidence/application/narrative-representation.js';
import type { EvidenceIssue } from '../../evidence/domain/result.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import type { PackDecision } from '../domain/pack-decisions.js';
import { uncertifiedThroughout, type ResolvedEvidenceView } from '../domain/resolved-view.js';
import { emittedPackIds } from '../domain/session-dedup.js';
import { CAPS, CUES, item, report, TIMINGS } from '../domain/test-support/pack.fixture.js';

const legacy = item('legacy', {
  labels: ['Narrative', 'Memory'],
  content: 'the original session overview',
});
const chunk = item('chunk', {
  labels: ['Narrative', 'Memory'],
  content: 'the bounded chunk interpretation',
});
const resonant = item('resonant-chunk', {
  labels: ['Narrative', 'Memory'],
  content: 'a related chunk interpretation',
});
const fact = item('fact', { labels: ['Decision', 'Memory'], content: 'an independent fact' });
const ranked = [legacy, chunk, fact, resonant];
const input: ServingAssembly = {
  ranked,
  served: new Map(),
  dedup: false,
  restated: [],
  assembly: {
    items: [legacy, chunk, fact],
    resonant: [resonant],
    admission: report(ranked),
    caps: CAPS,
    tokenBudget: 4000,
    cues: CUES,
    timings: TIMINGS,
  },
};
const view: ResolvedEvidenceView = {
  provenance: new Map(),
  relatedClaims: new Map(),
  ownership: new Map(),
  degraded: new Set(),
  issues: [],
  narrativeFamilies: {
    values: new Map([
      [
        'legacy',
        {
          family: 'legacy_session_overview',
          sessions: ['session'],
          selection: 'selected',
          publication: 'established',
        },
      ],
      [
        'chunk',
        {
          family: 'chunk',
          sessions: ['session'],
          selection: 'not_selected',
          publication: 'established',
        },
      ],
      [
        'resonant-chunk',
        {
          family: 'chunk',
          sessions: ['session'],
          selection: 'not_selected',
          publication: 'established',
        },
      ],
    ]),
  },
};

it('applies the same family policy to direct and resonant narratives', () => {
  const decisions: PackDecision[] = [];
  const answer = serveFrom(input, view, (decision) => decisions.push(decision));
  expect([...emittedPackIds(answer.pack)].sort()).toEqual(['fact', 'legacy']);
  expect(decisions.filter((decision) => decision.reason === 'representation_family')).toEqual([
    { id: 'chunk', bucket: 'narratives', reason: 'representation_family' },
    { id: 'resonant-chunk', bucket: 'resonant', reason: 'representation_family' },
  ]);
});

it('keeps only the committed family when a present publication boundary becomes uncertified', () => {
  const answer = serveFrom(
    input,
    uncertifiedThroughout(
      view,
      ranked.map((candidate) => candidate.id),
    ),
  );
  expect([...emittedPackIds(answer.pack)].sort()).toEqual(['fact', 'legacy']);
  expect(answer.pack.resonant?.some((entry) => entry.id === resonant.id)).not.toBe(true);
});

it('withholds only the unproved narrative representation at a historical vantage', () => {
  const historical = {
    ...view,
    narrativeFamilies: { values: new Map() },
  };
  const answer = serveFrom(
    input,
    uncertifiedThroughout(
      historical,
      ranked.map((candidate) => candidate.id),
    ),
  );
  expect([...emittedPackIds(answer.pack)]).toEqual(['fact']);
});

it('withholds unknown family and unpublished narratives with different named gaps', () => {
  const uncertain: ResolvedEvidenceView = {
    ...view,
    narrativeFamilies: {
      values: new Map([
        [
          'legacy',
          {
            family: 'legacy_session_overview',
            sessions: ['session'],
            selection: 'unknown',
            publication: 'established',
          },
        ],
        [
          'chunk',
          { family: 'chunk', sessions: ['session'], selection: 'selected', publication: 'unknown' },
        ],
      ]),
    },
  };
  const disclosed = discloseFamilyGaps(uncertain, ranked);
  expect([...emittedPackIds(serveFrom(input, disclosed).pack)]).toEqual(['fact']);
  expect(disclosed.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        address: { kind: 'id', id: 'legacy' },
        field: 'representation_preference',
        required: true,
      }),
      expect.objectContaining({
        address: { kind: 'id', id: 'chunk' },
        field: 'narrative_revision',
        required: true,
      }),
    ]),
  );
});

it('serves different families from different sessions while filtering each session independently', () => {
  const values = new Map(view.narrativeFamilies!.values);
  values.set('chunk', {
    family: 'chunk',
    sessions: ['other-session'],
    selection: 'selected',
    publication: 'established',
  });
  const mixed = { ...view, narrativeFamilies: { values } };
  expect([...emittedPackIds(serveFrom(input, mixed).pack)].sort()).toEqual([
    'chunk',
    'fact',
    'legacy',
  ]);
});

it('replaces reread policy issues while preserving an independent citation issue with the same vocabulary', () => {
  const old: EvidenceIssue = {
    address: { kind: 'id', id: 'legacy' },
    field: 'narrative_revision',
    reason: 'unverified_scope',
    required: false,
  };
  const independent: EvidenceIssue = { ...old };
  const values = new Map(view.narrativeFamilies!.values);
  values.set('legacy', {
    family: 'legacy_session_overview',
    sessions: ['session'],
    selection: 'selected',
    publication: 'unknown',
    policyIssues: [old],
  });
  const store = new SqliteStore({ filePath: ':memory:' });
  const reread = vi.spyOn(representations, 'revalidateNarrativeRepresentations').mockReturnValue({
    values: new Map(view.narrativeFamilies!.values),
    rereadIds: new Set(view.narrativeFamilies!.values.keys()),
    dependencies: [],
    issues: [],
  });
  try {
    const refreshed = revalidateFamilyPolicy(
      store.db,
      { ...view, issues: [old, independent], narrativeFamilies: { values } },
      checkedContext(),
      ranked,
    );
    expect(refreshed.issues).toHaveLength(1);
    expect(refreshed.issues[0]).toBe(independent);
    expect([...emittedPackIds(serveFrom(input, refreshed).pack)]).toContain('legacy');
  } finally {
    reread.mockRestore();
    store.close();
  }
});

it('preserves an issue for an identity the policy reread never acquired', () => {
  const missing: EvidenceIssue = {
    address: { kind: 'id', id: 'fact' },
    field: 'representation_preference',
    reason: 'store_unavailable',
    required: true,
  };
  const store = new SqliteStore({ filePath: ':memory:' });
  try {
    const result = revalidateFamilyPolicy(
      store.db,
      {
        ...view,
        issues: [missing],
        narrativeFamilies: {
          values: new Map([
            [
              'fact',
              { family: 'unknown', sessions: [], selection: 'unknown', publication: 'unknown' },
            ],
          ]),
        },
      },
      checkedContext(),
      [fact],
    );
    expect(result.issues).toContain(missing);
  } finally {
    store.close();
  }
});

it('does not erase an independently owned preference issue when a policy value is reread', () => {
  const independent: EvidenceIssue = {
    address: { kind: 'id', id: 'legacy' },
    field: 'representation_preference',
    reason: 'store_unavailable',
    required: false,
  };
  const store = new SqliteStore({ filePath: ':memory:' });
  const reread = vi.spyOn(representations, 'revalidateNarrativeRepresentations').mockReturnValue({
    values: new Map(view.narrativeFamilies!.values),
    rereadIds: new Set(['legacy']),
    dependencies: [],
    issues: [],
  });
  try {
    const result = revalidateFamilyPolicy(
      store.db,
      { ...view, issues: [independent] },
      checkedContext(),
      [legacy],
    );
    expect(result.issues).toContain(independent);
  } finally {
    reread.mockRestore();
    store.close();
  }
});
