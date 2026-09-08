import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { verifyEvidenceRevision } from './dependencies.js';
import { assembleJudgmentEvidence, type JudgmentPair } from './judgment.js';
import { EvidenceResolver } from './resolver.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { EVIDENCE_LIMITS, RequestBudget } from '../domain/budget.js';
import { durableRoleScope } from '../domain/scopes.js';
import {
  checkedContext,
  commitIncidence,
  commitSourceState,
  establishNodeState,
  establishScope,
  seedSource,
} from '../test-support/evidence.fixture.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');

/** Answers every read with nothing, which is what a claim naming no retained subject looks like. */
function emptyDriver(): Driver {
  return {
    executeQuery: () => Promise.resolve({ records: [] }),
  } as unknown as Driver;
}

function content(text: string): ReflectionContent {
  return { turns: [{ role: 'user', text, occurred_at: NOW.toISOString() }] };
}

function pair(reservedUnits = 0): JudgmentPair {
  return {
    route: 'live_supersession',
    reservedUnits,
    use: 'claim_judgment',
    sides: [
      { nodeId: 'claim-old', statement: 'the migration took 45 seconds' },
      { nodeId: 'claim-new', statement: 'the migration took 5 seconds' },
    ],
  };
}

describe('judgment evidence assembly', () => {
  let dir: string;
  let store: SqliteStore;
  let deps: { driver: Driver; db: SqliteStore['db'] };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-judgment-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    deps = { driver: emptyDriver(), db: store.db };
    for (const [source, claim] of [
      ['episode-old', 'claim-old'],
      ['episode-new', 'claim-new'],
    ]) {
      seedSource(store.db, {
        sourceId: source!,
        sessionId: 'session-1',
        identity: 'agent-1',
        content: content(`${claim!} was stated here`),
        turnIds: [`${source!}-turn`],
        now: NOW,
      });
      commitIncidence(store.db, {
        sourceId: source!,
        nodeId: claim!,
        role: 'extraction',
        operationId: `extract:${claim!}`,
        at: NOW,
      });
      establishScope(store.db, claim!, durableRoleScope('extraction', 'out'), NOW);
      // The negative scope a correction would arrive in is counted too: an uncounted one cannot
      // say that none arrived.
      establishScope(store.db, claim!, durableRoleScope('stated_correction', 'in'), NOW);
      // And the graph counter behind the statement itself, which the revision binds.
      establishNodeState(store.db, claim!, { revision: 1, at: NOW });
    }
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reserves each side its own exact source before anything optional', async () => {
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());

    expect(assembly.status).toBe('assembled');
    if (assembly.status !== 'assembled') {
      return;
    }
    expect(assembly.sides[0].requiredSources.map((source) => source.sourceId)).toEqual([
      'episode-old',
    ]);
    expect(assembly.sides[1].requiredSources[0]?.text).toContain('claim-new was stated here');
    expect(assembly.revision.dependencies.length).toBeGreaterThan(0);
  });

  it('reserves every occurrence a folded claim was extracted from', async () => {
    seedSource(store.db, {
      sourceId: 'episode-folded',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: content('the same fact, stated again'),
      turnIds: ['episode-folded-turn'],
      now: NOW,
    });
    commitIncidence(store.db, {
      sourceId: 'episode-folded',
      nodeId: 'claim-old',
      role: 'extraction',
      operationId: 'extract:folded',
      at: NOW,
    });
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());

    expect(assembly.status === 'assembled' ? assembly.sides[0].requiredSources : []).toHaveLength(
      2,
    );
  });

  it('abstains with no assembled input when a required source is proved suppressed', async () => {
    commitSourceState(store.db, {
      sourceId: 'episode-old',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: NOW,
    });
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());

    expect(assembly).toMatchObject({ status: 'abstained', reason: 'required_source_suppressed' });
    expect(assembly.status === 'abstained' ? assembly.addresses : []).toEqual([
      { kind: 'id', id: 'episode-old' },
    ]);
    expect('sides' in assembly).toBe(false);
  });

  it('keeps the abstention out of the history gaps and out of completeness', async () => {
    commitSourceState(store.db, {
      sourceId: 'episode-new',
      stateKind: 'suppressed',
      operationId: 'suppress-1',
      at: NOW,
    });
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());

    expect(assembly.status).toBe('abstained');
    expect(assembly.status === 'abstained' ? assembly.revision.contractVersion : 0).toBe(1);
  });

  it('pins a pair whose extraction scope nobody has counted', async () => {
    const fresh = new SqliteStore({ filePath: join(dir, 'unverified.sqlite') });
    try {
      const assembly = await assembleJudgmentEvidence(
        { driver: emptyDriver(), db: fresh.db },
        pair(),
        checkedContext(),
      );

      expect(assembly).toMatchObject({ status: 'incomplete' });
      expect(
        assembly.status === 'incomplete' ? assembly.reasons.map((reason) => reason.reason) : [],
      ).toEqual([
        'required_scope_missing',
        'required_scope_missing',
        'required_scope_missing',
        'required_scope_missing',
      ]);
      // Two of the four are the node states nobody counted, which the statements rest on.
      expect(
        assembly.status === 'incomplete'
          ? assembly.reasons.filter((reason) => reason.field === 'interpretation_text').length
          : 0,
      ).toBe(2);
    } finally {
      fresh.close();
    }
  });

  it('pins a pair whose required source cannot be verified', async () => {
    store.db
      .prepare("UPDATE source_records SET verified_content_digest = 'wrong' WHERE source_id = ?")
      .run('episode-old');
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());

    expect(assembly.status).toBe('incomplete');
    expect(
      assembly.status === 'incomplete' ? assembly.reasons.map((reason) => reason.reason) : [],
    ).toEqual(['unresolved_mapping']);
  });

  it('omits optional context while the required units stay complete', async () => {
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());

    expect(assembly.status).toBe('assembled');
    if (assembly.status !== 'assembled') {
      return;
    }
    expect(assembly.sides[0].optionalSubjects).toEqual([]);
    expect(assembly.omitted.length).toBeGreaterThan(0);
    expect(assembly.omitted.every((issue) => !issue.required)).toBe(true);
  });

  it('refuses a pair that does not fit the route allowance the caller reserved', async () => {
    const assembly = await assembleJudgmentEvidence(deps, pair(16380), checkedContext());

    expect(assembly.status).toBe('incomplete');
    expect(
      assembly.status === 'incomplete' ? assembly.reasons.map((reason) => reason.reason) : [],
    ).toEqual(['budget_limit', 'budget_limit']);
  });

  it('keeps the extraction membership dependency in the assembled revision', async () => {
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());
    if (assembly.status !== 'assembled') {
      throw new Error('fixture did not assemble');
    }
    seedSource(store.db, {
      sourceId: 'added-source',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: content('another witness'),
      turnIds: ['added-source-turn'],
      now: NOW,
    });
    commitIncidence(store.db, {
      sourceId: 'added-source',
      nodeId: 'claim-old',
      role: 'extraction',
      operationId: 'extract-added',
      at: NOW,
    });
    establishScope(store.db, 'claim-old', durableRoleScope('extraction', 'out'), NOW);

    expect(verifyEvidenceRevision(store.db, assembly.revision).status).toBe('stale');
  });

  it('records incoming correction scopes even when they are empty', async () => {
    const assembly = await assembleJudgmentEvidence(deps, pair(), checkedContext());
    if (assembly.status !== 'assembled') {
      throw new Error('fixture did not assemble');
    }
    establishScope(store.db, 'claim-old', durableRoleScope('stated_correction', 'in'), NOW);

    expect(verifyEvidenceRevision(store.db, assembly.revision).status).toBe('stale');
  });

  it('does not certify a judgment when the shared checkpoint budget is exhausted', async () => {
    const budget = new RequestBudget();
    budget.takeCheckpointAttempt();
    budget.takeCheckpointAttempt();
    const reader = new EvidenceResolver({
      ...deps,
      logger: { warn: () => undefined },
      publications: {
        checkpoint: () =>
          Promise.resolve({ status: 'unavailable' as const, reason: 'pending_publication' }),
      },
    });

    expect((await reader.assembleJudgment(pair(), checkedContext(), budget)).status).toBe(
      'incomplete',
    );
  });

  it('does not require entity sources to have claim extraction roles', async () => {
    for (const id of ['entity-a', 'entity-b']) {
      commitIncidence(store.db, {
        sourceId: 'episode-old',
        nodeId: id,
        role: 'mention',
        operationId: `mentions:${id}`,
        at: NOW,
      });
      for (const role of ['mention', 'participation', 'stated_correction'] as const) {
        establishScope(
          store.db,
          id,
          durableRoleScope(role, role === 'stated_correction' ? 'in' : 'in'),
          NOW,
        );
      }
      establishNodeState(store.db, id, { revision: 1, at: NOW });
    }
    const result = await assembleJudgmentEvidence(
      deps,
      {
        route: 'entity_merge',
        reservedUnits: 0,
        use: 'entity_judgment',
        sides: [
          { nodeId: 'entity-a', statement: 'Entity A' },
          { nodeId: 'entity-b', statement: 'Entity B' },
        ],
      },
      checkedContext(),
    );

    expect(result.status).toBe('assembled');
  });

  it('charges required-origin relations against the shared relation budget', async () => {
    const result = await assembleJudgmentEvidence(
      deps,
      pair(),
      checkedContext(),
      new RequestBudget({ ...EVIDENCE_LIMITS, relationRows: 0 }),
    );

    expect(result.status).toBe('incomplete');
    expect(
      result.status === 'incomplete' ? result.reasons.map((reason) => reason.reason) : [],
    ).toContain('budget_limit');
  });

  it('does not certify a judgment whose incoming correction census is unknown', async () => {
    store.db
      .prepare(
        "UPDATE evidence_scope_versions SET census_status='unknown' WHERE endpoint_id='claim-old' AND relation_class=?",
      )
      .run(durableRoleScope('stated_correction', 'in'));

    expect((await assembleJudgmentEvidence(deps, pair(), checkedContext())).status).toBe(
      'incomplete',
    );
  });

  it('does not certify one entity role while its other required role is uncounted', async () => {
    for (const id of ['entity-a', 'entity-b']) {
      commitIncidence(store.db, {
        sourceId: 'episode-old',
        nodeId: id,
        role: 'mention',
        operationId: `mentions:${id}`,
        at: NOW,
      });
      establishScope(store.db, id, durableRoleScope('mention', 'in'), NOW);
      establishScope(store.db, id, durableRoleScope('stated_correction', 'in'), NOW);
    }
    const result = await assembleJudgmentEvidence(
      deps,
      {
        route: 'entity_merge',
        reservedUnits: 0,
        use: 'entity_judgment',
        sides: [
          { nodeId: 'entity-a', statement: 'Entity A' },
          { nodeId: 'entity-b', statement: 'Entity B' },
        ],
      },
      checkedContext(),
    );

    expect(result.status).toBe('incomplete');
  });

  it('does not certify a nonempty extraction set whose census is still incomplete', async () => {
    store.db
      .prepare(
        "UPDATE evidence_scope_versions SET census_status='unbackfilled' WHERE endpoint_id='claim-old' AND relation_class=?",
      )
      .run(durableRoleScope('extraction', 'out'));

    expect((await assembleJudgmentEvidence(deps, pair(), checkedContext())).status).toBe(
      'incomplete',
    );
  });
});
