import { expect, it } from 'vitest';

import { resolvedView } from './resolved-view.js';
import type { ItemMetadata } from '../../evidence/application/metadata.js';
import { idAddress } from '../../evidence/domain/address.js';
import { evidenceResult, type EvidenceIssue } from '../../evidence/domain/result.js';
import { foldableClaims } from '../domain/pack-duplicates.js';
import { servedFingerprint, servedRecords, suppressedRepeats } from '../domain/session-dedup.js';
import { suppressedOwnSession } from '../domain/session-origin.js';
import { item } from '../domain/test-support/pack.fixture.js';

const first = item('first', {
  labels: ['Insight', 'Memory', 'AionNode'],
  content: 'Atlas uses Valkey.',
});
const second = item('second', {
  labels: ['Insight', 'Memory', 'AionNode'],
  content: 'atlas uses Valkey',
});
function value(complete = true): ItemMetadata {
  return {
    provenance: { roots: ['source'], complete },
    owningSessions: ['asking'],
    sources: ['source'],
    unknownAttribution: false,
    ownership: { sessions: ['asking'], unknownAttribution: false, censusEstablished: true },
    narrativeBinding: { status: 'none' },
  };
}
function view(
  issue?: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  withValue = true,
  complete = true,
) {
  const results = new Map(
    [first, second].map((candidate) => {
      const address = idAddress(candidate.id);
      const issues: EvidenceIssue[] =
        issue === undefined
          ? []
          : [
              {
                address,
                field: 'ownership',
                reason: issue,
                required: true,
              },
            ];
      return [
        JSON.stringify(['id', candidate.id]),
        evidenceResult<ItemMetadata>({
          address,
          residency: 'resident',
          issues,
          ...(withValue ? { value: value(complete) } : {}),
        }),
      ] as const;
    }),
  );
  return resolvedView({
    reading: { kind: 'resolved', results, issues: [] },
    relatedClaims: new Map(),
    sessionId: 'asking',
    attribute: true,
  });
}

it('does not withhold an own-session item after evidence certification failed', () => {
  const pending = view('pending_publication');
  expect(pending.degraded.has('first')).toBe(true);
  expect(suppressedOwnSession({ items: [first], view: pending }).size).toBe(0);
});

it('does not fold candidates using uncertified provenance carried with a pending result', () => {
  expect(
    foldableClaims({
      items: [first, second],
      pairs: [{ left: 'first', right: 'second' }],
      view: view('pending_publication'),
    }).size,
  ).toBe(0);
});

it('does not replace a healthy fingerprint when the metadata budget returned no semantic value', () => {
  const limited = view('budget_limit', false);
  const candidates = new Map([[first.id, first]]);
  expect(servedRecords(new Set([first.id]), candidates, limited)).toEqual([]);
});

it('keeps certified incomplete lineage eligible for normal fingerprint recording', () => {
  const known = view('depth_limit', true, false);
  expect(servedRecords(new Set([first.id]), new Map([[first.id, first]]), known)).toEqual([
    {
      itemId: first.id,
      fingerprint: servedFingerprint(first, value(false).provenance),
    },
  ]);
});

it('already preserves repeat suppression and holdings on a pending read', () => {
  const pending = view('pending_publication');
  const held = new Map([[first.id, servedFingerprint(first, value().provenance)]]);
  expect(suppressedRepeats([first], held, pending).size).toBe(0);
  expect(servedRecords(new Set([first.id]), new Map([[first.id, first]]), pending)).toEqual([]);
});

it('does not suppress or record a value whose certification ran out of budget', () => {
  const limited = view('budget_limit', true);
  const held = new Map([[first.id, servedFingerprint(first, value().provenance)]]);
  expect.soft(suppressedRepeats([first], held, limited).size).toBe(0);
  expect
    .soft(servedRecords(new Set([first.id]), new Map([[first.id, first]]), limited))
    .toEqual([]);
});
