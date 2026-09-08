import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runGraphMigrations } from './migrations.js';
import {
  bootstrapPublicationGuard,
  publicationGuardExists,
  PUBLICATION_GUARD_LABEL,
} from './publication-guard.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../sqlite/database.js';
import { readSubstratePairing } from '../sqlite/publication-control.js';

const EMBED_DIMENSION = 768;
const PROTOCOL_VERSION = 1;

describe('the publication guard node', () => {
  let harness: Neo4jHarness;
  let dir: string;

  beforeAll(async () => {
    harness = await startNeo4jHarness();
    dir = mkdtempSync(join(tmpdir(), 'aion-publication-guard-'));
    await runGraphMigrations(harness.driver, openSqliteHandle({ filePath: ':memory:' }), {
      embedDimension: EMBED_DIMENSION,
    });
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await stopNeo4jHarness(harness);
  });

  let substrateCount = 0;

  function freshSubstrate(): SqliteHandle {
    substrateCount += 1;
    return openSqliteHandle({ filePath: join(dir, `substrate-${substrateCount}.sqlite`) });
  }

  async function guardCount(): Promise<number> {
    const result = await harness.driver.executeQuery(
      `MATCH (g:${PUBLICATION_GUARD_LABEL}) RETURN count(g) AS n`,
    );
    const [record] = result.records;
    return (record?.get('n') as { toNumber(): number }).toNumber();
  }

  it('creates one guard for a fresh substrate and closes its bootstrap', async () => {
    const db = freshSubstrate();
    try {
      const before = await guardCount();
      const bootstrap = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);

      expect(bootstrap.outcome).toBe('created');
      expect(await guardCount()).toBe(before + 1);
      expect(await publicationGuardExists(harness.driver, bootstrap.substrateId)).toBe(true);
      expect(readSubstratePairing(db)?.bootstrapState).toBe('initialized');
    } finally {
      db.close();
    }
  });

  it('running it again on an initialized substrate joins its guard and writes nothing', async () => {
    const db = freshSubstrate();
    try {
      const first = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);
      const before = await guardCount();

      const second = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);
      const third = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);

      expect(second).toEqual({ substrateId: first.substrateId, outcome: 'joined' });
      expect(third).toEqual(second);
      expect(await guardCount()).toBe(before);
    } finally {
      db.close();
    }
  });

  it('finishes an interrupted bootstrap rather than minting a second identity', async () => {
    const path = join(dir, 'interrupted.sqlite');
    const first = openSqliteHandle({ filePath: path });
    // A pairing row with no guard behind it: the state an initial bootstrap that died between
    // the two writes leaves.
    const minted = first
      .prepare(
        `INSERT INTO publication_control (substrate_id, bootstrap_state, protocol_version)
         VALUES ('interrupted-substrate', 'pairing', ?)`,
      )
      .run(PROTOCOL_VERSION);
    expect(minted.changes).toBe(1);
    first.close();

    const reopened = openSqliteHandle({ filePath: path });
    try {
      const bootstrap = await bootstrapPublicationGuard(harness.driver, reopened, PROTOCOL_VERSION);

      expect(bootstrap).toEqual({ substrateId: 'interrupted-substrate', outcome: 'created' });
      expect(readSubstratePairing(reopened)?.substrateId).toBe('interrupted-substrate');
    } finally {
      reopened.close();
    }
  });

  it('reports a guard that went missing after initialization instead of replacing it', async () => {
    const db = freshSubstrate();
    try {
      const bootstrap = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);
      await harness.driver.executeQuery(
        `MATCH (g:${PUBLICATION_GUARD_LABEL} {substrate_id: $id}) REMOVE g:${PUBLICATION_GUARD_LABEL}`,
        { id: bootstrap.substrateId },
      );

      const after = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);

      expect(after).toEqual({ substrateId: bootstrap.substrateId, outcome: 'missing' });
      expect(await publicationGuardExists(harness.driver, bootstrap.substrateId)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('refuses a second guard claiming an identity that already has one', async () => {
    const db = freshSubstrate();
    try {
      const bootstrap = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);

      await expect(
        harness.driver.executeQuery(`CREATE (g:${PUBLICATION_GUARD_LABEL} {substrate_id: $id})`, {
          id: bootstrap.substrateId,
        }),
      ).rejects.toThrow(/already exists/i);
    } finally {
      db.close();
    }
  });

  it('carries neither the base node label nor the memory label', async () => {
    const db = freshSubstrate();
    try {
      const bootstrap = await bootstrapPublicationGuard(harness.driver, db, PROTOCOL_VERSION);
      const result = await harness.driver.executeQuery(
        `MATCH (g:${PUBLICATION_GUARD_LABEL} {substrate_id: $id}) RETURN labels(g) AS labels`,
        { id: bootstrap.substrateId },
      );
      const [record] = result.records;

      expect(record?.get('labels')).toEqual([PUBLICATION_GUARD_LABEL]);
    } finally {
      db.close();
    }
  });
});
