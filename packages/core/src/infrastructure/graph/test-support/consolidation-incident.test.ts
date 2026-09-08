import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INCIDENT_DIR_ENV,
  independentReaderSession,
  loadIncidentCapture,
  packageIncidentFixture,
  type IncidentCapture,
} from './consolidation-incident.fixture.js';
import { manifestIsComplete } from '../../../introspection/domain/campaign-fixture-manifest.js';

const OLD_CLAIM = '1aa31184c852f7290f3e80f4f0419d6df45144d2afa55cc90eb3c40963a19400';
const NEW_CLAIM = '0f2dc7d16aed6fc4a3aa84122ab1f9cfa799880e08d81d1f6348adbef0649dea';
const CLOSED_AT = '2026-09-07T12:11:30.640000000Z';

const TARGETS = {
  observedAt: '2026-09-07T17:25:31.983Z',
  event: { id: 543, ids: ['x'], retrieved: ['x', 'y'] },
  targets: [
    {
      id: OLD_CLAIM,
      labels: ['AionNode', 'Memory', 'Event'],
      text: 'the old result',
      occurredAt: '2026-09-06T21:25:43.360000000Z',
      txFrom: '2026-09-06T21:25:54.385000000Z',
      txUntil: CLOSED_AT,
      validUntil: CLOSED_AT,
      forgottenAt: null,
    },
    {
      id: NEW_CLAIM,
      labels: ['AionNode', 'Memory', 'Event'],
      text: 'the new result',
      occurredAt: null,
      txFrom: '2026-09-07T05:10:44.399000000Z',
      txUntil: null,
      validUntil: null,
      forgottenAt: null,
    },
  ],
  sources: [
    {
      claimId: OLD_CLAIM,
      episodeId: '2ddd41e4-d5cf-4c6d-a293-b72af5a021ea',
      sessionId: '01a07861-ae9f-72f3-8636-001c5ab7cf6d',
      text: 'observation: the old run',
    },
  ],
  lineage: [
    {
      successorId: NEW_CLAIM,
      predecessorId: OLD_CLAIM,
      createdAt: '2026-09-07T15:23:41.211Z',
      validUntil: null,
      txUntil: null,
      provenance: ['supersession_introspector_resolution'],
    },
  ],
  archive: [
    {
      id: 'b946edfa-ec21-4e66-8f68-060afc815375',
      identity: '01a07861-ae9f-72f3-8636-001c5ab7cf6d',
      session_id: '01a07861-ae9f-72f3-8636-001c5ab7cf6d',
      episode_id: '2ddd41e4-d5cf-4c6d-a293-b72af5a021ea',
      occurred_at: '2026-09-06T21:25:43.360Z',
      archived_at: '2026-09-06T21:25:43.360Z',
      payload_json: '{"observations":["the old run"]}',
    },
  ],
};

const PROVENANCE = {
  proposals: [
    {
      id: 'cc70a054-e667-4dd9-84a3-5be6f73dcda7',
      old_id: OLD_CLAIM,
      new_id: NEW_CLAIM,
      rationale: 'the focused test count changed',
      confidence: 0.92,
      episode_id: '908450e4-9ffd-42f6-98e1-218004d8cc4c',
      created_at: '2026-09-07T05:11:00.000Z',
      resolved_at: '2026-09-07T15:23:41.211Z',
    },
  ],
};

let dir: string;

function write(name: string, body: string): string {
  writeFileSync(join(dir, name), body);
  return createHash('sha256').update(Buffer.from(body)).digest('hex');
}

/** The whole preserved set, since the loader verifies every artifact the capture is made of. */
function seedCapture(overrides: { manifest?: string } = {}): void {
  const lines = [
    `${write('targets.json', JSON.stringify(TARGETS))}  targets.json`,
    `${write('provenance.json', JSON.stringify(PROVENANCE))}  provenance.json`,
    `${write('round-9-astra-recall.json', '{"round":9}')}  round-9-astra-recall.json`,
    `${write('round-9-astra-trace.md', '# trace\n')}  round-9-astra-trace.md`,
  ];
  writeFileSync(join(dir, 'SHA256SUMS'), overrides.manifest ?? `${lines.join('\n')}\n`);
}

function loaded(): IncidentCapture {
  const outcome = loadIncidentCapture(dir);
  if (outcome.status !== 'loaded') {
    throw new Error(`capture did not load: ${outcome.status}`);
  }
  return outcome.capture;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-incident-fixture-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verifying the capture before anything is built from it', () => {
  it('loads a capture whose every digest matches', () => {
    seedCapture();
    const capture = loaded();
    expect(capture.recallEventId).toBe(543);
    expect(capture.claims.map((claim) => claim.id)).toEqual([OLD_CLAIM, NEW_CLAIM]);
    expect(capture.artifacts.map((artifact) => artifact.name)).toEqual([
      'targets.json',
      'provenance.json',
      'round-9-astra-recall.json',
      'round-9-astra-trace.md',
    ]);
  });

  it('stops on a changed digest and names the artifact', () => {
    seedCapture();
    writeFileSync(join(dir, 'targets.json'), JSON.stringify({ ...TARGETS, observedAt: 'later' }));
    expect(loadIncidentCapture(dir)).toMatchObject({
      status: 'failed',
      reason: 'digest_mismatch',
      artifact: 'targets.json',
    });
  });

  it('stops on an artifact the capture does not hold', () => {
    seedCapture();
    rmSync(join(dir, 'provenance.json'));
    expect(loadIncidentCapture(dir)).toMatchObject({
      status: 'failed',
      reason: 'artifact_missing',
      artifact: 'provenance.json',
    });
  });

  it('reports a directory that holds no manifest rather than reading past it', () => {
    expect(loadIncidentCapture(dir)).toMatchObject({
      status: 'unreadable',
      artifact: 'SHA256SUMS',
    });
  });

  it('treats an unnamed capture location as a run that needs none', () => {
    expect(loadIncidentCapture('')).toMatchObject({ status: 'not_configured' });
    expect(loadIncidentCapture('  ')).toMatchObject({ status: 'not_configured' });
  });

  it('carries the stored payload and its size, decoded from the bytes that were verified', () => {
    seedCapture();
    const capture = loaded();
    expect(capture.archive[0]?.payloadBytes).toBe(32);
    expect(capture.archive[0]?.payload.observations).toEqual(['the old run']);
  });

  it('refuses a manifest that leaves a preserved artifact uncovered', () => {
    seedCapture();
    const onlyTargets = `${createHash('sha256')
      .update(Buffer.from(JSON.stringify(TARGETS)))
      .digest('hex')}  targets.json\n`;
    writeFileSync(join(dir, 'SHA256SUMS'), onlyTargets);
    expect(loadIncidentCapture(dir)).toMatchObject({
      status: 'failed',
      reason: 'required_artifact_unlisted',
    });
  });
});

describe('the observed snapshot variant', () => {
  it('keeps the closure, the lineage edge and the proposal exactly as observed', () => {
    seedCapture();
    const fixture = packageIncidentFixture(loaded(), 'incident-snapshot');
    expect(fixture.claims[0]?.validUntil).toBe(CLOSED_AT);
    expect(fixture.lineage).toHaveLength(1);
    expect(fixture.proposals).toHaveLength(1);
    expect(fixture.proposals[0]?.rationale).toBe('the focused test count changed');
    // The only differences it declares are the vectors held back from every variant; no stamp,
    // edge or proposal is excluded.
    expect([...new Set(fixture.manifest.deltas.map((delta) => delta.reason))]).toEqual([
      'stored content and context vectors are held back from every variant',
    ]);
    expect(manifestIsComplete(fixture.manifest)).toBe(true);
  });

  it('keeps the ordered turns with their roles and clocks', () => {
    seedCapture();
    const fixture = packageIncidentFixture(loaded(), 'incident-snapshot');
    expect(fixture.archive[0]?.payload.observations).toEqual(['the old run']);
  });

  it('names the fields the capture could not recover instead of filling them', () => {
    seedCapture();
    const fixture = packageIncidentFixture(loaded(), 'incident-snapshot');
    expect(fixture.manifest.unknownFields).toContainEqual({
      subject: NEW_CLAIM,
      field: 'occurred_at',
    });
    expect(fixture.manifest.unknownFields).toContainEqual({
      subject: 'cc70a054-e667-4dd9-84a3-5be6f73dcda7',
      field: 'submitted_prompt',
    });
  });

  it('keeps the original identities rather than renaming them', () => {
    seedCapture();
    const fixture = packageIncidentFixture(loaded(), 'incident-snapshot');
    expect(Object.values(fixture.manifest.originalIds)).toContain(OLD_CLAIM);
    expect(Object.values(fixture.manifest.originalIds)).toContain(
      '2ddd41e4-d5cf-4c6d-a293-b72af5a021ea',
    );
  });
});

describe('the before-judgment variant', () => {
  it('rewinds past the closure and lists every exclusion it made', () => {
    seedCapture();
    const fixture = packageIncidentFixture(loaded(), 'isolated-before-judgment');
    expect(fixture.claims.every((claim) => claim.validUntil === null)).toBe(true);
    expect(fixture.lineage).toEqual([]);
    expect(fixture.proposals).toEqual([]);
    expect([...new Set(fixture.manifest.deltas.map((delta) => delta.kind))].sort()).toEqual([
      'excluded_edge',
      'excluded_proposal',
      'excluded_stamp',
    ]);
    // The stamp deltas name both clocks the rewind clears, not only the world-time one.
    const stamps = fixture.manifest.deltas.filter((delta) => delta.subject === OLD_CLAIM);
    expect(stamps.some((delta) => delta.reason.includes('valid_until'))).toBe(true);
    expect(stamps.some((delta) => delta.reason.includes('tx_until'))).toBe(true);
    expect(fixture.claims.every((claim) => claim.txUntil === null)).toBe(true);
    expect(manifestIsComplete(fixture.manifest)).toBe(true);
  });

  it('says which closure it rewound past', () => {
    seedCapture();
    const fixture = packageIncidentFixture(loaded(), 'isolated-before-judgment');
    expect(fixture.manifest.classification).toContain(CLOSED_AT);
  });

  it('keeps the sources and the archive rows the observed variant holds', () => {
    seedCapture();
    const capture = loaded();
    const isolated = packageIncidentFixture(capture, 'isolated-before-judgment');
    const observed = packageIncidentFixture(capture, 'incident-snapshot');
    expect(isolated.sources).toEqual(observed.sources);
    expect(isolated.archive).toEqual(observed.archive);
  });
});

/**
 * The preserved capture itself, when a run names where it is. Skipped otherwise: the bytes live
 * outside the repository, and a run that is not comparing anything needs none of them.
 */
describe.runIf(process.env[INCIDENT_DIR_ENV] !== undefined)('the preserved capture', () => {
  it('verifies, decodes, and holds the recall event that served neither claim', () => {
    const outcome = loadIncidentCapture();
    expect(outcome.status).toBe('loaded');
    if (outcome.status !== 'loaded') {
      return;
    }
    const { capture } = outcome;
    expect(capture.artifacts).toHaveLength(4);
    expect(capture.claims.map((claim) => claim.id)).toEqual([OLD_CLAIM, NEW_CLAIM]);
    expect(capture.emitted).not.toContain(OLD_CLAIM);
    expect(capture.emitted).not.toContain(NEW_CLAIM);
    expect(capture.retrieved).not.toContain(OLD_CLAIM);
    expect(capture.retrieved).not.toContain(NEW_CLAIM);
  });

  it('packages both variants from the verified bytes', () => {
    const outcome = loadIncidentCapture();
    if (outcome.status !== 'loaded') {
      throw new Error(`capture did not load: ${outcome.status}`);
    }
    const observed = packageIncidentFixture(outcome.capture, 'incident-snapshot');
    const isolated = packageIncidentFixture(outcome.capture, 'isolated-before-judgment');
    expect(manifestIsComplete(observed.manifest)).toBe(true);
    expect(manifestIsComplete(isolated.manifest)).toBe(true);
    expect(isolated.claims.every((claim) => claim.validUntil === null)).toBe(true);
  });
});

/**
 * What a consumer reads off the packaged fixture: the parts of the NEW source, the scope each
 * result was reported against, and whether the reader asking is a different reader.
 */
describe.runIf(process.env[INCIDENT_DIR_ENV] !== undefined)(
  'the packaged incident evidence',
  () => {
    function fixture(): ReturnType<typeof packageIncidentFixture> {
      const outcome = loadIncidentCapture();
      if (outcome.status !== 'loaded') {
        throw new Error(`capture did not load: ${outcome.status}`);
      }
      return packageIncidentFixture(outcome.capture, 'incident-snapshot');
    }

    it('keeps the three ordered turns of the newer source with their roles and clocks', () => {
      const turns = fixture().archive[1]?.payload.turns ?? [];
      expect(turns).toHaveLength(3);
      expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'assistant']);
      expect(turns.map((turn) => turn.occurred_at)).toEqual([
        '2026-09-07T05:08:55.648Z',
        '2026-09-07T05:08:59.391Z',
        '2026-09-07T05:10:44.399Z',
      ]);
    });

    it('carries both commit scopes the two results were reported against', () => {
      const packaged = fixture();
      const older = JSON.stringify(packaged.archive[0]?.payload);
      const newer = JSON.stringify(packaged.archive[1]?.payload);
      expect(older).toContain('105d3a2e54d704d4a1585c9e9dd7a75aa776365a');
      expect(newer).toContain('0559691');
    });

    it('keeps the judgment rationale and the extraction-edge clock beside the claims', () => {
      const packaged = fixture();
      expect(packaged.proposals[0]?.rationale).not.toBe(null);
      expect(packaged.sources.every((source) => source.edgeCreatedAt !== null)).toBe(true);
    });

    it('admits a reader whose resolved session is none of the source sessions', () => {
      const outcome = loadIncidentCapture();
      if (outcome.status !== 'loaded') {
        throw new Error(`capture did not load: ${outcome.status}`);
      }
      const sessions = { sessionIdFor: (identity: string) => identity };
      expect(independentReaderSession(sessions, 'reader-asking-fresh', outcome.capture)).toEqual({
        status: 'independent',
        sessionId: 'reader-asking-fresh',
      });
      const source = outcome.capture.sources[0]?.sessionId ?? '';
      expect(independentReaderSession(sessions, source, outcome.capture)).toEqual({
        status: 'rejected',
        reason: 'resolves_to_source_session',
      });
    });
  },
);
