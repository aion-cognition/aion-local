import type { EntityMergeProposal, NodeEdge, NodeProvenance, SupersessionProposal } from '@aion/core';
import { describe, expect, it } from 'vitest';
import { MissingNodeIdError, parseWhyFlags, renderProvenance, UnknownWhyOptionError } from './why.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseWhyFlags', () => {
  it('reads a bare node id', () => {
    expect(parseWhyFlags(['node-1'])).toEqual({ nodeId: 'node-1' });
  });

  it('rejects no id and an extra argument', () => {
    expect(() => parseWhyFlags([])).toThrow(MissingNodeIdError);
    expect(() => parseWhyFlags(['node-1', 'extra'])).toThrow(UnknownWhyOptionError);
  });
});

const CURRENT: NodeProvenance = {
  id: 'decision-1',
  labels: ['Decision', 'Memory', 'AionNode'],
  content: 'we picked webhooks over polling',
  extractionMethod: undefined,
  sourceEpisodeId: undefined,
  rationale: 'polling was too slow at our volume',
  currency: 'current',
  occurredAt: new Date('2026-06-01T11:00:00.000Z'),
  validFrom: new Date('2026-06-01T11:00:00.000Z'),
  txFrom: new Date('2026-06-01T11:00:05.000Z'),
};

const SUPERSEDED: NodeProvenance = {
  ...CURRENT,
  id: 'decision-old',
  currency: 'superseded',
  validUntil: new Date('2026-06-05T00:00:00.000Z'),
  txUntil: new Date('2026-06-05T00:00:01.000Z'),
  supersededBy: { id: 'decision-1', at: new Date('2026-06-05T00:00:00.000Z') },
};

const EDGES: readonly NodeEdge[] = [
  {
    type: 'EXTRACTED_FROM',
    outgoing: true,
    otherId: 'episode-1',
    otherLabels: ['Episode', 'Memory'],
    otherContent: 'discussed ingestion options',
    strength: 1,
    confidence: 1,
    count: 0,
    provenance: ['cognitive-extraction'],
    signals: ['reflection'],
    createdAt: new Date('2026-06-01T11:00:05.000Z'),
  },
  {
    type: 'SUPERSEDES',
    outgoing: false,
    otherId: 'decision-old',
    otherLabels: ['Decision', 'Memory'],
    otherContent: 'we picked polling',
    strength: 1,
    confidence: 1,
    count: 0,
    provenance: ['supersession'],
    signals: ['bitemporal'],
    createdAt: new Date('2026-06-05T00:00:00.000Z'),
  },
  {
    type: 'MENTIONS',
    outgoing: false,
    otherId: 'episode-1',
    otherLabels: ['Episode', 'Memory'],
    otherContent: 'discussed ingestion options',
    strength: 1,
    confidence: 0.9,
    count: 1,
    provenance: ['entity-extraction'],
    signals: ['episodic'],
    createdAt: new Date('2026-06-01T11:00:05.000Z'),
  },
];

const SUPERSESSION_PROPOSAL: SupersessionProposal = {
  id: 'prop-1',
  oldId: 'aaaaaaaa-0000-0000-0000-000000000000',
  newId: 'bbbbbbbb-1111-1111-1111-111111111111',
  confidence: 0.95,
  rationale: 'restated with a corrected reason',
  episodeId: 'episode-2',
  createdAt: '2026-06-05T00:00:00.000Z',
  resolvedAt: null,
};

const ENTITY_MERGE_PROPOSAL: EntityMergeProposal = {
  id: 'merge-1',
  leftId: 'entity-1',
  leftName: 'Postgres',
  leftType: 'technology',
  rightId: 'entity-2',
  rightName: 'PostgreSQL',
  rightType: 'technology',
  similarity: 0.94,
  episodeId: 'episode-3',
  createdAt: '2026-06-05T00:00:00.000Z',
  resolvedAt: null,
};

describe('renderProvenance', () => {
  it('renders the node record, currency, and bitemporal stamps', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, [], [], [], write);

    const text = lines.join('\n');
    expect(text).toContain('node     decision-1');
    expect(text).toContain('currency  current');
    expect(text).toContain('occurred_at   2026-06-01T11:00:00.000Z');
    expect(text).toContain('valid_until   open');
    expect(text).toContain('forgotten_at  not forgotten');
  });

  it('shows a superseded node honestly, with what replaced it and when', () => {
    const { lines, write } = collector();

    renderProvenance(SUPERSEDED, [], [], [], write);

    const text = lines.join('\n');
    expect(text).toContain('currency  superseded');
    expect(text).toContain('superseded by decision-1 at 2026-06-05T00:00:00.000Z');
    expect(text).toContain('valid_until   2026-06-05T00:00:00.000Z');
  });

  it('renders the extraction provenance chain from the EXTRACTED_FROM edge', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, EDGES, [], [], write);

    const text = lines.join('\n');
    expect(text).toContain('extracted from     episode-1 (Episode, Memory), method: cognitive-extraction');
  });

  it('renders supersession lineage in both directions', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, EDGES, [], [], write);

    expect(lines.join('\n')).toContain('superseded by  decision-old (Decision, Memory)');
  });

  it('renders open supersession and entity-merge proposals touching the node', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, [], [SUPERSESSION_PROPOSAL], [ENTITY_MERGE_PROPOSAL], write);

    const text = lines.join('\n');
    expect(text).toContain('supersession prop-1: would close aaaaaaaa in favour of bbbbbbbb (confidence 0.95)');
    expect(text).toContain('entity-merge merge-1: Postgres + PostgreSQL at 0.940');
  });

  it('omits a resolved proposal from the open list', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, [], [{ ...SUPERSESSION_PROPOSAL, resolvedAt: '2026-06-06T00:00:00.000Z' }], [], write);

    const text = lines.join('\n');
    expect(text).toContain('open proposals\n  none');
    expect(text).not.toContain('prop-1');
  });

  it('summarizes edges by type', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, EDGES, [], [], write);

    const text = lines.join('\n');
    expect(text).toMatch(/EXTRACTED_FROM\s+1/);
    expect(text).toMatch(/MENTIONS\s+1/);
    expect(text).toMatch(/SUPERSEDES\s+1/);
  });

  it('says plainly when there is nothing on a given axis', () => {
    const { lines, write } = collector();

    renderProvenance(CURRENT, [], [], [], write);

    const text = lines.join('\n');
    expect(text).toContain('no source episode recorded');
    expect(text).toContain('supersession lineage\n  none');
    expect(text).toContain('edges by type\n  none');
  });
});
