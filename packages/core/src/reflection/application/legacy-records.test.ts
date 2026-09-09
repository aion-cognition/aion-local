import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acknowledgeCensusSeal,
  acknowledgeMaterialization,
  discardMaterialization,
  endpointCensusScopes,
  isNodeEndpoint,
  pageUncountedEndpoints,
  prepareCensusSeal,
  prepareMaterialization,
  unaccountedCohortMembers,
  type PlannedLink,
} from './legacy-records.js';
import { readRelationScope } from '../../evidence/application/dependencies.js';
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import { committedIncidenceForNode } from '../../infrastructure/sqlite/committed-evidence.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  freezeMigrationCohort,
  recordMigrationProgress,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  acknowledgePublicationIntent,
  preparePublicationIntent,
} from '../../infrastructure/sqlite/publication-intents.js';

const NOW = new Date('2026-09-09T02:00:00.000Z');
const SOURCE = 'episode-1';
const NODE = 'entity-1';

function link(overrides: Partial<PlannedLink> = {}): PlannedLink {
  const kind = overrides.kind ?? 'mention';
  const toId = overrides.toId ?? NODE;
  return {
    linkId: evidenceLinkId(kind, 'retained_node', SOURCE, toId),
    kind,
    qualifier: 'retained_node',
    fromId: SOURCE,
    toId,
    relationId: 'rel-1',
    relationType: 'MENTIONS',
    incident: true,
    closed: false,
    clocks: {},
    ...overrides,
  };
}

const SCOPES = [
  { endpointId: SOURCE, relationClass: 'sqlite:mention:out' },
  { endpointId: NODE, relationClass: 'sqlite:mention:in' },
];

describe('the durable half of a legacy materialization', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-legacy-records-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** The intent every committed read joins through, so a version can actually become visible. */
  function intent(operationId: string): void {
    preparePublicationIntent(store.db, {
      operationId,
      kind: 'legacy_materialization',
      payloadDigest: 'digest',
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '[]',
      createdAt: NOW,
    });
  }

  function acknowledge(operationId: string): void {
    acknowledgePublicationIntent(store.db, {
      operationId,
      resultDigest: 'result',
      resultJson: '{}',
      observedAckAt: NOW,
    });
  }

  it('keeps a prepared incidence out of the committed view until the operation lands', () => {
    intent('op-1');
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'op-1',
      links: [link()],
      scopes: SCOPES,
      observedAt: NOW,
    });

    expect(committedIncidenceForNode(store.db, NODE, 'mention')).toEqual([]);

    acknowledge('op-1');
    acknowledgeMaterialization(
      store.db,
      { sourceId: SOURCE, operationId: 'op-1', scopes: SCOPES, observedAt: NOW },
      NOW.toISOString(),
      NOW.toISOString(),
    );

    expect(committedIncidenceForNode(store.db, NODE, 'mention')).toMatchObject([
      { sourceId: SOURCE, nodeId: NODE, role: 'mention', currency: 'open' },
    ]);
  });

  it('records the original relationship identity so a rebuild lands on the same link', () => {
    intent('op-1');
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'op-1',
      links: [link({ relationId: 'graph-rel-77' })],
      scopes: SCOPES,
      observedAt: NOW,
    });

    const row = store.db
      .prepare('SELECT original_rel_id AS id, record_source AS source FROM evidence_links')
      .get() as { id: string; source: string };
    expect(row).toEqual({ id: 'graph-rel-77', source: 'legacy_materialization' });
  });

  it('never writes over a version a later statement already acknowledged', () => {
    intent('live');
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'live',
      links: [link()],
      scopes: SCOPES,
      observedAt: NOW,
    });
    acknowledge('live');
    acknowledgeMaterialization(
      store.db,
      { sourceId: SOURCE, operationId: 'live', scopes: SCOPES, observedAt: NOW },
      NOW.toISOString(),
      NOW.toISOString(),
    );

    intent('baseline');
    const counts = prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'baseline',
      links: [link({ relationId: 'graph-rel-1' })],
      scopes: SCOPES,
      observedAt: NOW,
    });

    expect(counts).toEqual({ recorded: 0, preserved: 1 });
    const versions = store.db.prepare('SELECT count(*) AS n FROM evidence_link_versions').get() as {
      n: number;
    };
    expect(versions.n).toBe(1);
  });

  it('carries the recorded currency of a retired legacy edge', () => {
    intent('op-1');
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'op-1',
      links: [link({ closed: true, clocks: { valid_until: '2026-02-01T00:00:00.000Z' } })],
      scopes: SCOPES,
      observedAt: NOW,
    });
    acknowledge('op-1');
    acknowledgeMaterialization(
      store.db,
      { sourceId: SOURCE, operationId: 'op-1', scopes: SCOPES, observedAt: NOW },
      NOW.toISOString(),
      NOW.toISOString(),
    );

    expect(committedIncidenceForNode(store.db, NODE, 'mention')[0]?.currency).toBe('closed');
  });

  it('advances the scope numbers and counts nothing: one source is not the population', () => {
    intent('op-1');
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'op-1',
      links: [link()],
      scopes: SCOPES,
      observedAt: NOW,
    });
    acknowledge('op-1');
    acknowledgeMaterialization(
      store.db,
      { sourceId: SOURCE, operationId: 'op-1', scopes: SCOPES, observedAt: NOW },
      NOW.toISOString(),
      NOW.toISOString(),
    );

    const scope = readScopeVersion(store.db, {
      endpointId: NODE,
      relationClass: 'sqlite:mention:in',
    });
    expect(scope?.publishedRevision).toBe(1);
    expect(scope?.censusStatus).toBe('unknown');
  });

  it('releases the parked numbers on a discard and leaves the published one alone', () => {
    intent('op-1');
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'op-1',
      links: [link()],
      scopes: SCOPES,
      observedAt: NOW,
    });
    discardMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'op-1',
      scopes: SCOPES,
      observedAt: NOW,
    });

    const scope = readScopeVersion(store.db, {
      endpointId: NODE,
      relationClass: 'sqlite:mention:in',
    });
    expect(scope?.publishedRevision).toBe(0);
    expect(scope?.pendingOperationId).toBeNull();
    // The number it consumed is not handed out again.
    expect(scope?.allocatedRevision).toBe(1);
  });
});

describe('the census seal', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-legacy-seal-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    preparePublicationIntent(store.db, {
      operationId: 'materialize',
      kind: 'legacy_materialization',
      payloadDigest: 'digest',
      payloadJson: '{}',
      affectedScopesJson: '[]',
      expectedJson: '{}',
      preparedActionsJson: '[]',
      createdAt: NOW,
    });
    prepareMaterialization(store.db, {
      sourceId: SOURCE,
      operationId: 'materialize',
      links: [link()],
      scopes: SCOPES,
      observedAt: NOW,
    });
    acknowledgePublicationIntent(store.db, {
      operationId: 'materialize',
      resultDigest: 'result',
      resultJson: '{}',
      observedAckAt: NOW,
    });
    acknowledgeMaterialization(
      store.db,
      { sourceId: SOURCE, operationId: 'materialize', scopes: SCOPES, observedAt: NOW },
      NOW.toISOString(),
      NOW.toISOString(),
    );
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('waits while any member of the cohort is still unwalked', () => {
    freezeMigrationCohort(store.db, {
      cohortId: 'cohort-1',
      cohortDigest: 'digest',
      intakeWatermark: 0,
      archiveRowidLow: 0,
      archiveRowidHigh: 0,
      graphCensusDigest: 'graph',
      orderingPolicyVersion: 1,
      createdAt: NOW,
      members: [SOURCE, 'episode-2'],
    });

    expect(unaccountedCohortMembers(store.db, 'cohort-1')).toBe(2);

    for (const sourceId of [SOURCE, 'episode-2']) {
      recordMigrationProgress(store.db, {
        cohortId: 'cohort-1',
        sourceId,
        status: 'verified',
        reason: 'walked',
      });
    }

    expect(unaccountedCohortMembers(store.db, 'cohort-1')).toBe(0);
  });

  it('counts the roles a node has no row for, which is where a missing count hides', () => {
    const scopes = endpointCensusScopes(store.db, NODE);

    // Each at the direction the registry puts it under. Extraction is the claim's own, so it is
    // counted at `out` on the node; `subjects.ts` and OWNERSHIP_SCOPES read it there.
    expect([...scopes].sort()).toEqual([
      'sqlite.revision_citations',
      'sqlite:extraction:out',
      'sqlite:mention:in',
      'sqlite:participation:in',
      'sqlite:source_coverage:in',
      'sqlite:stated_confirmation:in',
      'sqlite:stated_correction:in',
      'sqlite:stated_derivation:in',
    ]);
  });

  it('counts only what a source endpoint actually carries', () => {
    expect(isNodeEndpoint(store.db, SOURCE)).toBe(false);
    expect(endpointCensusScopes(store.db, SOURCE)).toEqual(['sqlite:mention:out']);
  });

  it('turns an unknown support answer into a counted one, and only at the seal', () => {
    expect(certifyNodeSupport(store.db, 'entity-empty').support).toBe('unknown');

    const endpoints = [{ endpointId: NODE, scopes: [...endpointCensusScopes(store.db, NODE)] }];
    prepareCensusSeal(store.db, { operationId: 'seal', endpoints, observedAt: NOW });
    const established = acknowledgeCensusSeal(
      store.db,
      { operationId: 'seal', endpoints, observedAt: NOW },
      NOW.toISOString(),
    );

    expect(established).toBe(endpoints[0]?.scopes.length);
    // The node this cohort recorded a mention for is supported; it is the counting that changed,
    // not the evidence.
    expect(certifyNodeSupport(store.db, NODE).support).toBe('supported');
  });

  it('leaves every counted scope established and every uncounted one alone', () => {
    const endpoints = [{ endpointId: NODE, scopes: [...endpointCensusScopes(store.db, NODE)] }];
    prepareCensusSeal(store.db, { operationId: 'seal', endpoints, observedAt: NOW });
    acknowledgeCensusSeal(
      store.db,
      { operationId: 'seal', endpoints, observedAt: NOW },
      NOW.toISOString(),
    );

    for (const relationClass of endpoints[0]?.scopes ?? []) {
      expect(readScopeVersion(store.db, { endpointId: NODE, relationClass })?.censusStatus).toBe(
        'established',
      );
    }
    // The source's own end is a different endpoint and this page did not count it.
    expect(
      readScopeVersion(store.db, { endpointId: SOURCE, relationClass: 'sqlite:mention:out' })
        ?.censusStatus,
    ).toBe('unknown');
  });

  it('counts the corrections that never arrived, so a decision about the node can be checked', () => {
    // Before the seal the scope is unverified, and a judgment resting on "nothing corrects this"
    // pins rather than deciding. Nothing has counted, so an empty read is silence.
    const scope = { kind: 'node' as const, endpointId: NODE, scope: 'sqlite:stated_correction:in' };
    expect(readRelationScope(store.db, { ...scope, empty: true }).status).toBe('unverified');

    const endpoints = [{ endpointId: NODE, scopes: [...endpointCensusScopes(store.db, NODE)] }];
    prepareCensusSeal(store.db, { operationId: 'seal', endpoints, observedAt: NOW });
    acknowledgeCensusSeal(
      store.db,
      { operationId: 'seal', endpoints, observedAt: NOW },
      NOW.toISOString(),
    );

    const reading = readRelationScope(store.db, { ...scope, empty: true });
    expect(reading.status).toBe('verified');
    expect(reading.status === 'verified' && reading.dependency.scope).toBe(
      'sqlite:stated_correction:in',
    );
  });

  it('drops a counted endpoint out of the page the next seal reads', () => {
    expect(pageUncountedEndpoints(store.db, '', 10)).toContain(NODE);

    const endpoints = [{ endpointId: NODE, scopes: [...endpointCensusScopes(store.db, NODE)] }];
    prepareCensusSeal(store.db, { operationId: 'seal', endpoints, observedAt: NOW });
    acknowledgeCensusSeal(
      store.db,
      { operationId: 'seal', endpoints, observedAt: NOW },
      NOW.toISOString(),
    );

    expect(pageUncountedEndpoints(store.db, '', 10)).not.toContain(NODE);
  });
});
