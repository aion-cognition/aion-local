import { afterEach, describe, expect, it } from 'vitest';

import {
  RehearsalTargetRefused,
  preflightVerdict,
  productionTarget,
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './consolidation-rehearsal.fixture.js';
import { runRead } from '../connection.js';

/**
 * The admission check against a real container. Its subject is the container the harness
 * actually created and the endpoint it actually answers on, which is the pair the rule
 * compares.
 */

let substrate: RehearsalSubstrate | undefined;

afterEach(async () => {
  const held = substrate;
  substrate = undefined;
  await stopRehearsalSubstrate(held);
});

describe('admitting a rehearsal substrate', () => {
  it('hands back a container this run created, and says why it admitted it', async () => {
    substrate = await startRehearsalSubstrate();
    expect(substrate.verdict).toEqual({ status: 'isolated', basis: 'harness_created' });
    expect(substrate.harness.shared).toBe(false);

    const rows = await runRead(
      substrate.harness.driver,
      'RETURN 1 AS ok',
      {},
      (row) => row.ok as number,
    );
    expect(rows).toEqual([1]);
  }, 300_000);

  it('refuses a rehearsal file in the running data directory before it creates anything', async () => {
    const production = { graphUri: 'bolt://neo4j:7687', sqlitePath: '/data/aion.sqlite' };
    expect(preflightVerdict(production, '/data/rehearsal.sqlite', {})).toMatchObject({
      status: 'rejected',
      reason: 'production_data_root',
    });

    await expect(
      startRehearsalSubstrate({ sqlitePath: '/data/rehearsal.sqlite', production }),
    ).rejects.toBeInstanceOf(RehearsalTargetRefused);
  }, 300_000);
});

describe('what production is taken to be', () => {
  it('reads the running endpoint from the environment, with the shipped defaults behind it', () => {
    expect(productionTarget({})).toEqual({
      graphUri: 'bolt://neo4j:7687',
      sqlitePath: '/data/aion.sqlite',
    });
    expect(productionTarget({ AION_NEO4J_URI: 'bolt://elsewhere:7687' }).graphUri).toBe(
      'bolt://elsewhere:7687',
    );
  });
});
