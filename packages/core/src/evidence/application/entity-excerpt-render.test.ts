import { describe, expect, it } from 'vitest';

import {
  renderExcerpt,
  renderSharedExcerpts,
  renderSideExcerpts,
  type OmissionKind,
  type SourceExcerpt,
} from './entity-excerpt-render.js';
import { ENTITY_MERGE_ROUTE_RESERVE } from '../../reflection/application/entity-merge-judge.js';
import { LIVE_SUPERSESSION_ROUTE_RESERVE } from '../../reflection/application/stages/supersession-judge.js';
import {
  ENTITY_EXCERPT_LIMITS,
  EVIDENCE_LIMITS,
  RENDERED_SIDE_OVERHEAD,
  renderableUnits,
} from '../domain/budget.js';

const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

/** The longest label an excerpt can carry, around the longest window it can show. */
function worstExcerpt(): SourceExcerpt {
  return {
    sourceId: UUID,
    sessionId: UUID,
    occurredAt: '2026-09-20T12:00:00.000Z',
    partOccurredAt: '2026-09-20T12:00:00.000Z',
    address: { kind: 'part', sourceId: UUID, partKind: 'turn', ordinal: 199 },
    partKind: 'turn',
    ordinal: 199,
    role: 'assistant',
    partDigest: 'd'.repeat(64),
    start: 12_345,
    end: 12_345 + ENTITY_EXCERPT_LIMITS.windowUnits,
    partUnits: 32_768,
    text: 'w'.repeat(ENTITY_EXCERPT_LIMITS.windowUnits),
    placement: { kind: 'no_literal_match' },
    nominatedAs: 'prompting',
    sides: [],
    currency: 'closed',
    decodedRawUtf8Bytes: ENTITY_EXCERPT_LIMITS.partBytes,
  };
}

const EVERY_OMISSION: readonly OmissionKind[] = [
  'withheld',
  'oversized',
  'unverified',
  'unplaced',
  'spent',
];

describe('entity excerpt limits', () => {
  // Two sides of seats and a prompting episode that may be recorded against neither.
  const sources = 2 * ENTITY_EXCERPT_LIMITS.sourcesPerSide + 1;

  it('gate every nominated source within one request address allowance', () => {
    expect(sources).toBeLessThanOrEqual(EVIDENCE_LIMITS.requestedIds);
  });

  it('read every nomination page within one request relation allowance', () => {
    const seats = ENTITY_EXCERPT_LIMITS.sourcesPerSide;
    // The prompt lookup, both sides' corrections, the shared page, and both recent pages with the
    // one probe row each.
    const rows = 2 * 3 + 2 * seats + seats + 2 * (seats + 1);

    expect(rows).toBeLessThanOrEqual(EVIDENCE_LIMITS.relationRows);
  });

  it('leave room for more than one long part in the pair decode allowance', () => {
    expect(ENTITY_EXCERPT_LIMITS.partBytes).toBeLessThanOrEqual(
      EVIDENCE_LIMITS.decodedRawBytes / 2,
    );
  });

  it('fit the worst-case excerpts beside either route reserve and a long pair description', () => {
    const excerpt = worstExcerpt();
    // A source recorded against both sides can show two parts.
    const excerpts = Array.from({ length: 2 * sources }, () => excerpt);
    const longName = 'n'.repeat(256);
    const rendered = [
      renderSideExcerpts({
        name: longName,
        excerpts,
        omissions: EVERY_OMISSION,
        unreadSourcesRemain: true,
      }),
      renderSideExcerpts({
        name: longName,
        excerpts: [],
        omissions: EVERY_OMISSION,
        unreadSourcesRemain: true,
      }),
      renderSharedExcerpts({
        names: [longName, longName],
        excerpts: [],
        omissions: EVERY_OMISSION,
      }),
    ].reduce((total, text) => total + text.length + RENDERED_SIDE_OVERHEAD, 2 * longName.length);
    const description = 16_384;

    expect(renderExcerpt(excerpt).length).toBeLessThan(ENTITY_EXCERPT_LIMITS.windowUnits + 400);
    for (const reserve of [ENTITY_MERGE_ROUTE_RESERVE, LIVE_SUPERSESSION_ROUTE_RESERVE]) {
      for (const route of ['entity_merge', 'proposal_resolution'] as const) {
        expect(rendered).toBeLessThanOrEqual(
          renderableUnits({ route, reservedUnits: reserve + description }),
        );
      }
    }
  });
});

describe('renderSideExcerpts', () => {
  it('says the text is a selection, and counts what it left out by reason', () => {
    const text = renderSideExcerpts({
      name: 'Aion Local',
      excerpts: [{ ...worstExcerpt(), text: 'Aion Local is the service.', sides: [0] }],
      omissions: ['withheld', 'withheld', 'oversized'],
      unreadSourcesRemain: true,
    });

    expect(text).toContain('excerpts, not whole sources');
    expect(text).toContain('More sources are recorded against it and were not read.');
    expect(text).toContain('[prompting episode] source');
    expect(text).toContain('a recorded mention since retired');
    expect(text).toContain(
      'Not shown: 2 sources withheld from disclosure; 1 source whose mention sits only in parts',
    );
  });

  it('says so plainly when nothing could be shown for a side', () => {
    const text = renderSideExcerpts({
      name: 'Aion Local',
      excerpts: [],
      omissions: ['unverified'],
      unreadSourcesRemain: false,
    });

    expect(text).toBe(
      'No captured text recorded against Aion Local alone could be shown.\n' +
        'Not shown: 1 source that could not be verified against its record.',
    );
  });
});
