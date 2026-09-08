import { describe, expect, it } from 'vitest';

import { resolvedView, type EvidenceReading } from './resolved-view.js';
import type { ItemMetadata } from '../../evidence/application/metadata.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { OwnershipSummary } from '../../evidence/domain/ownership.js';
import { evidenceResult, type EvidenceResult } from '../../evidence/domain/result.js';
import type { ItemProvenance } from '../../infrastructure/graph/claim-provenance-queries.js';
import type { ItemOrigin } from '../../infrastructure/graph/origin-queries.js';
import { ownershipOf } from '../domain/resolved-view.js';

const PROVENANCE: ItemProvenance = { roots: ['episode-a'], complete: true };

function ownership(sessions: readonly string[]): OwnershipSummary {
  return { sessions: [...sessions], unknownAttribution: false, censusEstablished: true };
}

function metadata(sessions: readonly string[]): ItemMetadata {
  return {
    provenance: PROVENANCE,
    owningSessions: [...sessions],
    sources: ['episode-a'],
    unknownAttribution: false,
    ownership: ownership(sessions),
    narrativeBinding: { status: 'unavailable' },
  };
}

function resolved(
  entries: readonly (readonly [string, EvidenceResult<ItemMetadata>])[],
): EvidenceReading {
  return { kind: 'resolved', results: new Map(entries), issues: [] };
}

function complete(id: string, sessions: readonly string[]): EvidenceResult<ItemMetadata> {
  return evidenceResult({
    address: idAddress(id),
    residency: 'resident',
    issues: [],
    value: metadata(sessions),
  });
}

function view(reading: EvidenceReading, attribute = true) {
  return resolvedView({ reading, relatedClaims: new Map(), sessionId: 'session-a', attribute });
}

describe('the view a certified read produces', () => {
  it('carries the resolver provenance and the verdict for the asking session', () => {
    const built = view(
      resolved([
        ['["id","c1"]', complete('c1', ['session-a'])],
        ['["id","c2"]', complete('c2', ['session-a', 'session-b'])],
      ]),
    );

    expect(built.provenance.get('c1')).toEqual(PROVENANCE);
    expect(ownershipOf(built, 'c1')).toBe('own_only');
    expect(ownershipOf(built, 'c2')).toBe('shared');
  });

  /**
   * A store the read could not reach may not overwrite healthy stored metadata. A certified
   * incomplete lineage is a settled answer, so it is not degraded and fingerprints normally.
   */
  it('marks only what a store outage cost it', () => {
    const outage = evidenceResult<ItemMetadata>({
      address: idAddress('c3'),
      residency: 'resident',
      issues: [
        {
          address: idAddress('c3'),
          field: 'ownership',
          reason: 'store_unavailable',
          required: true,
        },
      ],
    });
    const short = evidenceResult<ItemMetadata>({
      address: idAddress('c4'),
      residency: 'resident',
      issues: [
        {
          address: idAddress('c4'),
          field: 'source_content',
          reason: 'depth_limit',
          required: true,
        },
      ],
      value: metadata(['session-a']),
    });
    const built = view(
      resolved([
        ['["id","c3"]', outage],
        ['["id","c4"]', short],
      ]),
    );

    expect([...built.degraded]).toEqual(['c3']);
    expect(built.provenance.has('c4')).toBe(true);
  });

  it('draws no verdict at all where the read does not subtract the asker own record', () => {
    const built = view(resolved([['["id","c1"]', complete('c1', ['session-a'])]]), false);

    expect(built.ownership.size).toBe(0);
    expect(ownershipOf(built, 'c1')).toBe('unknown');
  });
});

describe('the view the pack own late reads produce', () => {
  function stage(
    records: ReadonlyMap<string, ItemProvenance>,
    origins: ReadonlyMap<string, ItemOrigin>,
    unavailable = false,
  ): EvidenceReading {
    return {
      kind: 'stage',
      provenance: { records, requested: ['c1', 'c2'], unavailable },
      origins,
    };
  }

  it('reads the graph own and other pair as a verdict without naming a session', () => {
    const built = view(
      stage(
        new Map([['c1', PROVENANCE]]),
        new Map([
          ['c1', { own: true, other: false }],
          ['c2', { own: true, other: true }],
        ]),
      ),
    );

    expect(ownershipOf(built, 'c1')).toBe('own_only');
    expect(ownershipOf(built, 'c2')).toBe('shared');
  });

  it('answers unknown for a node nothing attributes to any session', () => {
    const built = view(stage(new Map(), new Map([['c1', { own: false, other: false }]])));

    expect(ownershipOf(built, 'c1')).toBe('unknown');
  });

  /**
   * The empty map a failed provenance read returns says nothing about any candidate, so every id
   * it was asked about keeps whatever fingerprint the last healthy read stored.
   */
  it('marks every requested id degraded when the provenance read failed', () => {
    const built = view(stage(new Map(), new Map(), true));

    expect([...built.degraded]).toEqual(['c1', 'c2']);
  });

  it('marks nothing degraded when the read answered', () => {
    const built = view(stage(new Map([['c1', PROVENANCE]]), new Map()));

    expect([...built.degraded]).toEqual([]);
  });
});
