import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { assembleJudgmentEvidence, type JudgmentAssembly, type JudgmentPair } from './judgment.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  transitionSourceResidency,
  type SourceResidencyState,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { durableRoleScope } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  establishNodeState,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

/**
 * A correction judged the same way wherever its evidence is stored.
 *
 * Residency is operational: whether the raw projection is here, on its way out, or gone. It is not
 * evidence, and a judgment that moved because a source had been evicted would be a judgment about
 * storage. The archive and the identity records outlive the projection, so the assembly reads the
 * same bytes in all three storage states and hands the judge the same statement each time.
 *
 * The fourth state is not a storage state at all. `unknown-mapping` is what the resolver says when
 * it cannot account for a source, and a required source nobody can account for is the one case
 * where the assembly must refuse rather than answer. Both sides are here: the same pair assembles
 * identically across the three, and refuses on the fourth with the address it could not resolve.
 *
 * Sited on the assembly because that is where a residency change could leak into a decision. The
 * supersession stage seeds its priors into a fake graph and has no source records to move, and the
 * gate runner it would otherwise borrow drives a live model.
 */

const NOW = new Date('2026-09-12T10:00:00.000Z');
const CORRECTED = 'claim-old';
const CORRECTION = 'claim-new';
const PRIOR_SOURCE = 'episode-old';
const CORRECTION_SOURCE = 'episode-new';

/** Answers every read with nothing, which is what a claim naming no retained subject looks like. */
function emptyDriver(): Driver {
  return {
    executeQuery: () => Promise.resolve({ records: [] }),
  } as unknown as Driver;
}

function content(text: string): ReflectionContent {
  return { turns: [{ role: 'user', text, occurred_at: NOW.toISOString() }] };
}

/** A valid correction: one claim replacing another, each resting on its own occurrence. */
function correction(): JudgmentPair {
  return {
    route: 'live_supersession',
    reservedUnits: 0,
    use: 'claim_judgment',
    sides: [
      { nodeId: CORRECTED, statement: 'the migration took 45 seconds' },
      { nodeId: CORRECTION, statement: 'the migration took 5 seconds' },
    ],
  };
}

let dir: string;
let store: SqliteStore;
let deps: { driver: Driver; db: SqliteStore['db'] };

function seedClaim(sourceId: string, claimId: string): void {
  seedSource(store.db, {
    sourceId,
    sessionId: 'session-1',
    identity: 'agent-1',
    content: content(`${claimId} was stated here`),
    turnIds: [`${sourceId}-turn`],
    now: NOW,
  });
  commitIncidence(store.db, {
    sourceId,
    nodeId: claimId,
    role: 'extraction',
    operationId: `extract:${claimId}`,
    at: NOW,
  });
  establishScope(store.db, claimId, durableRoleScope('extraction', 'out'), NOW);
  establishScope(store.db, claimId, durableRoleScope('stated_correction', 'in'), NOW);
  establishNodeState(store.db, claimId, { revision: 1, at: NOW });
}

function moveResidency(sourceId: string, state: SourceResidencyState): void {
  transitionSourceResidency(store.db, {
    sourceId,
    state,
    operationId: `residency:${sourceId}:${state}`,
    transitionedAt: NOW,
  });
}

/** The sources each side reserved, addressed and rendered, which is what the judge is shown. */
function reserved(assembly: JudgmentAssembly): readonly (readonly [string, string])[] {
  if (assembly.status !== 'assembled') {
    throw new Error(`expected an assembled judgment, got ${assembly.status}`);
  }
  return assembly.sides.flatMap((side) =>
    side.evidence === 'whole_sources'
      ? side.requiredSources.map((source) => [source.sourceId, source.text] as const)
      : [],
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-judgment-residency-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  deps = { driver: emptyDriver(), db: store.db };
  seedClaim(PRIOR_SOURCE, CORRECTED);
  seedClaim(CORRECTION_SOURCE, CORRECTION);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it.each(['resident', 'retiring', 'evicted'] as const)(
  'assembles the same correction with its prior %s',
  async (state) => {
    const before = reserved(await assembleJudgmentEvidence(deps, correction(), checkedContext()));
    moveResidency(PRIOR_SOURCE, state);

    const after = await assembleJudgmentEvidence(deps, correction(), checkedContext());

    expect(after.status).toBe('assembled');
    expect(reserved(after)).toEqual(before);
  },
);

it('assembles the same correction with both of its occurrences evicted', async () => {
  const before = reserved(await assembleJudgmentEvidence(deps, correction(), checkedContext()));
  moveResidency(PRIOR_SOURCE, 'evicted');
  moveResidency(CORRECTION_SOURCE, 'evicted');

  expect(reserved(await assembleJudgmentEvidence(deps, correction(), checkedContext()))).toEqual(
    before,
  );
});

it('carries no residency into what the judge is handed', async () => {
  moveResidency(PRIOR_SOURCE, 'evicted');
  const assembly = await assembleJudgmentEvidence(deps, correction(), checkedContext());

  expect(assembly.status).toBe('assembled');
  if (assembly.status !== 'assembled') {
    return;
  }
  // Not merely unused: the reserved source has no residency field to branch on, so nothing
  // downstream of here could make a decision turn on where the bytes are kept.
  for (const source of assembly.sides.flatMap((side) =>
    side.evidence === 'whole_sources' ? side.requiredSources : [],
  )) {
    expect(source).not.toHaveProperty('residency');
  }
});

it('refuses a correction whose prior nobody can account for', async () => {
  // The fourth state is not a transition. It is what the resolver answers when the address names
  // no source it holds records for, which is why it is a refusal and the other three are not.
  const orphaned: JudgmentPair = {
    ...correction(),
    sides: [
      { nodeId: 'claim-unaccounted', statement: 'the migration took 45 seconds' },
      { nodeId: CORRECTION, statement: 'the migration took 5 seconds' },
    ],
  };
  commitIncidence(store.db, {
    sourceId: 'episode-unaccounted',
    nodeId: 'claim-unaccounted',
    role: 'extraction',
    operationId: 'extract:claim-unaccounted',
    at: NOW,
  });
  establishScope(store.db, 'claim-unaccounted', durableRoleScope('extraction', 'out'), NOW);
  establishScope(store.db, 'claim-unaccounted', durableRoleScope('stated_correction', 'in'), NOW);
  establishNodeState(store.db, 'claim-unaccounted', { revision: 1, at: NOW });

  const assembly = await assembleJudgmentEvidence(deps, orphaned, checkedContext());

  expect(assembly.status).toBe('incomplete');
  if (assembly.status !== 'incomplete') {
    return;
  }
  expect(assembly.reasons.map((reason) => reason.reason)).toContain('unresolved_mapping');
  expect(assembly.reasons.map((reason) => reason.address)).toContainEqual({
    kind: 'id',
    id: 'episode-unaccounted',
  });
});

it('refuses on the unaccounted prior whatever the other side reads', async () => {
  // The refusal is about the source that could not be resolved, not about the pair, so moving the
  // side that DID resolve changes nothing about the answer.
  moveResidency(CORRECTION_SOURCE, 'evicted');
  commitIncidence(store.db, {
    sourceId: 'episode-unaccounted',
    nodeId: CORRECTED,
    role: 'extraction',
    operationId: 'extract:unaccounted-prior',
    at: NOW,
  });

  const assembly = await assembleJudgmentEvidence(deps, correction(), checkedContext());

  expect(assembly.status).toBe('incomplete');
  if (assembly.status !== 'incomplete') {
    return;
  }
  expect(assembly.reasons.map((reason) => reason.reason)).toContain('unresolved_mapping');
});
