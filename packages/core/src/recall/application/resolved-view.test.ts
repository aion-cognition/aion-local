import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';

import {
  readEvidence,
  resolvedView,
  type EvidenceReadDeps,
  type EvidenceReading,
} from './resolved-view.js';
import type { ItemMetadata } from '../../evidence/application/metadata.js';
import type { EvidenceResolver } from '../../evidence/application/resolver.js';
import { idAddress } from '../../evidence/domain/address.js';
import type { OwnershipSummary } from '../../evidence/domain/ownership.js';
import { evidenceResult, type EvidenceResult } from '../../evidence/domain/result.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
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
  it('marks only the reading whose inputs it could not obtain', () => {
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

/**
 * Which reads one attempt issues. A time-traveled read neither discounts nor subtracts the
 * asker's own record, so it asks nobody whose memory this is; it still reads the evidence behind
 * every candidate, because honesty about what the substrate holds is not one of the exemptions.
 */
describe('the reads one attempt issues', () => {
  function recording(log: string[]): Driver {
    return {
      executeQuery: (cypher: string) => {
        log.push(cypher);
        return Promise.resolve({ records: [] });
      },
    } as unknown as Driver;
  }

  function deps(driver: Driver): EvidenceReadDeps {
    return {
      driver,
      db: {} as never,
      provider: {} as never,
      config: {} as never,
      logger: { warn: () => undefined } as never,
    };
  }

  it('reads the evidence but asks nothing about ownership where it may not subtract', async () => {
    const log: string[] = [];
    await readEvidence(deps(recording(log)), {
      ids: ['c1'],
      sessionId: 'session-a',
      mode: {},
      attribute: false,
    });

    expect(log.some((cypher) => cypher.includes('capture_ids'))).toBe(true);
    expect(log.some((cypher) => cypher.includes(' AS own,'))).toBe(false);
  });

  it('asks about ownership where the read does subtract', async () => {
    const log: string[] = [];
    await readEvidence(deps(recording(log)), {
      ids: ['c1'],
      sessionId: 'session-a',
      mode: {},
      attribute: true,
    });

    expect(log.some((cypher) => cypher.includes(' AS own,'))).toBe(true);
  });

  /** With a checked context and a resolver in hand the pack takes no late read of its own. */
  it('goes through the resolver when an entry point checked coverage', async () => {
    const log: string[] = [];
    const resolver = {
      resolveMetadata: () => Promise.resolve({ results: new Map(), issues: [], revision: {} }),
    } as unknown as EvidenceResolver;
    const reading = await readEvidence(
      { ...deps(recording(log)), resolver },
      {
        ids: ['c1'],
        sessionId: 'session-a',
        mode: {},
        attribute: true,
        context: checkedContext(),
      },
    );

    expect(reading.kind).toBe('resolved');
    expect(log).toEqual([]);
  });
});
