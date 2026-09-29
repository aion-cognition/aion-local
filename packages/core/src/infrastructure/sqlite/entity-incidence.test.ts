import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openSqliteHandle, type SqliteHandle } from './database.js';
import { incidenceOfSource, newestIncidentSources } from './entity-incidence.js';
import { commitIncidence, seedSource } from '../../evidence/test-support/evidence.fixture.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const ROLES = ['mention', 'participation'];

let dir: string;
let db: SqliteHandle;

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

/** One source, captured at its own moment in its own session, recorded against `nodes`. */
function capture(input: {
  readonly id: string;
  readonly session: string;
  readonly minutesAgo: number;
  readonly nodes: readonly string[];
  readonly text?: string;
  readonly role?: string;
}): void {
  seedSource(db, {
    sourceId: input.id,
    sessionId: input.session,
    identity: input.session,
    content: {
      turns: [
        {
          role: 'user',
          text: input.text ?? `capture ${input.id}`,
          occurred_at: minutesAgo(input.minutesAgo),
        },
      ],
    },
    now: NOW,
  });
  for (const node of input.nodes) {
    commitIncidence(db, {
      sourceId: input.id,
      nodeId: node,
      role: input.role ?? 'mention',
      operationId: `link:${input.id}:${node}`,
      at: NOW,
    });
  }
}

function ids(rows: readonly { readonly sourceId: string }[]): string[] {
  return rows.map((row) => row.sourceId);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-entity-incidence-'));
  db = openSqliteHandle({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('newestIncidentSources', () => {
  it('reads the newest sources first, one per session before any second', () => {
    capture({ id: 'a-old', session: 's-a', minutesAgo: 50, nodes: ['entity'] });
    capture({ id: 'a-new', session: 's-a', minutesAgo: 10, nodes: ['entity'] });
    capture({ id: 'b-only', session: 's-b', minutesAgo: 30, nodes: ['entity'] });
    capture({ id: 'c-only', session: 's-c', minutesAgo: 40, nodes: ['entity'] });

    const rows = newestIncidentSources(db, {
      nodeId: 'entity',
      roles: ROLES,
      exclude: [],
      limit: 10,
    });

    expect(ids(rows)).toEqual(['a-new', 'b-only', 'c-only', 'a-old']);
  });

  it('reads no more rows than the limit it was charged for', () => {
    for (let index = 0; index < 30; index += 1) {
      capture({
        id: `s-${String(index)}`,
        session: `session-${String(index)}`,
        minutesAgo: index,
        nodes: ['entity'],
      });
    }

    const rows = newestIncidentSources(db, {
      nodeId: 'entity',
      roles: ROLES,
      exclude: [],
      limit: 5,
    });

    expect(ids(rows)).toEqual(['s-0', 's-1', 's-2', 's-3', 's-4']);
  });

  it('shows a repeated capture of the same content once, the newest standing for it', () => {
    capture({ id: 'first', session: 's-a', minutesAgo: 30, nodes: ['entity'], text: 'same words' });
    capture({ id: 'again', session: 's-b', minutesAgo: 30, nodes: ['entity'], text: 'same words' });
    capture({ id: 'other', session: 's-c', minutesAgo: 20, nodes: ['entity'] });

    const rows = newestIncidentSources(db, {
      nodeId: 'entity',
      roles: ROLES,
      exclude: [],
      limit: 10,
    });

    expect(ids(rows)).toHaveLength(2);
    expect(ids(rows)[0]).toBe('other');
  });

  it('leaves out the sources already nominated', () => {
    capture({ id: 'one', session: 's-a', minutesAgo: 10, nodes: ['entity'] });
    capture({ id: 'two', session: 's-b', minutesAgo: 20, nodes: ['entity'] });

    const rows = newestIncidentSources(db, {
      nodeId: 'entity',
      roles: ROLES,
      exclude: ['one'],
      limit: 10,
    });

    expect(ids(rows)).toEqual(['two']);
  });

  it('reads only the roles asked for, one row per source across them', () => {
    capture({ id: 'mentioned', session: 's-a', minutesAgo: 10, nodes: ['entity'] });
    commitIncidence(db, {
      sourceId: 'mentioned',
      nodeId: 'entity',
      role: 'participation',
      operationId: 'participation:mentioned',
      at: NOW,
    });
    capture({
      id: 'corrected',
      session: 's-b',
      minutesAgo: 5,
      nodes: ['entity'],
      role: 'stated_correction',
    });

    expect(
      ids(newestIncidentSources(db, { nodeId: 'entity', roles: ROLES, exclude: [], limit: 10 })),
    ).toEqual(['mentioned']);
    expect(
      ids(
        newestIncidentSources(db, {
          nodeId: 'entity',
          roles: ['stated_correction'],
          exclude: [],
          limit: 10,
        }),
      ),
    ).toEqual(['corrected']);
  });

  it('does not read rows whose owning operation was never acknowledged', () => {
    capture({ id: 'committed', session: 's-a', minutesAgo: 10, nodes: ['entity'] });
    seedSource(db, {
      sourceId: 'prepared-only',
      sessionId: 's-b',
      identity: 's-b',
      content: { turns: [{ role: 'user', text: 'prepared', occurred_at: minutesAgo(1) }] },
      now: NOW,
    });
    db.prepare(
      `INSERT INTO evidence_link_versions
         (link_id, version, prev_version, state, recorded_values_json, temporal_proof_json,
          observed_at, operation_key, operation_id, known_from, observed_ack_at)
       VALUES ('pending-link', 1, NULL, 'asserted', '{}', '{}', ?, 'key:pending', 'op-pending',
               NULL, NULL)`,
    ).run(NOW.toISOString());
    db.prepare(
      `INSERT INTO source_incidence (source_id, node_id, role, currency, link_id, link_version)
       VALUES ('prepared-only', 'entity', 'mention', 'open', 'pending-link', 1)`,
    ).run();

    expect(
      ids(newestIncidentSources(db, { nodeId: 'entity', roles: ROLES, exclude: [], limit: 10 })),
    ).toEqual(['committed']);
  });

  it('sorts a source with no record, and so no clock, after every dated one', () => {
    capture({ id: 'dated', session: 's-a', minutesAgo: 500, nodes: ['entity'] });
    commitIncidence(db, {
      sourceId: 'unrecorded',
      nodeId: 'entity',
      role: 'mention',
      operationId: 'link:unrecorded',
      at: NOW,
    });

    expect(
      ids(newestIncidentSources(db, { nodeId: 'entity', roles: ROLES, exclude: [], limit: 10 })),
    ).toEqual(['dated', 'unrecorded']);
  });

  it('reads only the sources recorded against both nodes when asked for a shared read', () => {
    capture({ id: 'both', session: 's-a', minutesAgo: 20, nodes: ['left', 'right'] });
    capture({ id: 'left-only', session: 's-b', minutesAgo: 5, nodes: ['left'] });
    capture({ id: 'right-only', session: 's-c', minutesAgo: 5, nodes: ['right'] });

    const rows = newestIncidentSources(db, {
      nodeId: 'left',
      roles: ROLES,
      alsoIncidentTo: 'right',
      exclude: [],
      limit: 10,
    });

    expect(ids(rows)).toEqual(['both']);
  });

  it('marks a source current when any of its rows is', () => {
    capture({ id: 'retired', session: 's-a', minutesAgo: 20, nodes: [] });
    commitIncidence(db, {
      sourceId: 'retired',
      nodeId: 'entity',
      role: 'mention',
      operationId: 'retired-mention',
      at: NOW,
      currency: 'closed',
    });

    expect(
      newestIncidentSources(db, { nodeId: 'entity', roles: ROLES, exclude: [], limit: 10 }),
    ).toEqual([{ sourceId: 'retired', currency: 'closed' }]);
  });
});

describe('incidenceOfSource', () => {
  it('names which of the pair one source is recorded against', () => {
    capture({ id: 'episode', session: 's-a', minutesAgo: 1, nodes: ['left'] });
    capture({ id: 'elsewhere', session: 's-b', minutesAgo: 1, nodes: ['right'] });

    expect(
      incidenceOfSource(db, {
        sourceId: 'episode',
        nodeIds: ['left', 'right'],
        roles: ROLES,
        limit: 6,
      }),
    ).toEqual([{ nodeId: 'left', role: 'mention', currency: 'open' }]);
  });
});
