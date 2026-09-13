import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INSTALLED_PUBLICATION_HANDLERS } from './installed-publications.js';
import { intakePublication } from './intake-publication.js';
import { handleReflection, type ReflectionIntakeDeps } from './intake.js';
import { LaneAssigner } from './lanes.js';
import { certifyNodeSupport } from '../../evidence/application/node-support.js';
import {
  ownershipCensusEstablished,
  ownershipIncidence,
  ownershipSummaryFor,
} from '../../evidence/application/ownership.js';
import { ownershipVerdict, OWNERSHIP_SCOPES } from '../../evidence/domain/ownership.js';
import { durableRoleScope, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import { checkedContext } from '../../evidence/test-support/evidence.fixture.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import { bootstrapBackbone } from '../../infrastructure/graph/backbone.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from '../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { PublicationBoundary } from '../../infrastructure/publication/types.js';
import { activateCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { openSqliteHandle, type SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';
import {
  coordinatorControl,
  publicationRecord,
  storedPlan,
} from '../../infrastructure/sqlite/publication-coordinator-store.js';
import { readSourcePartTurnIds } from '../../infrastructure/sqlite/source-identity.js';
import { SessionManager } from '../../session/session-manager.js';

/**
 * What an acceptance leaves behind on the node side of the ids it mints, against both real stores.
 *
 * The acceptance census counts what could have been STATED about a fresh source. This is the same
 * write counting what could have been RECORDED about the ids it drew, which is what an ownership
 * reader asks before it will say whose a memory is. Intake runs through the real coordinator here
 * rather than through its own phases, because the last case is a prepared acceptance the substrate
 * then refuses, and only the protocol can put a write in that state.
 */

const EMBED_DIMENSION = 8;
const WRITING_SESSION = 'minted-census-writer';
const OTHER_SESSION = 'minted-census-reader';
/** What a hook fire puts in `session_id`: the harness conversation, not the transport it opened. */
const STAMPED_SESSION = 'minted-census-harness';
const NOW = new Date('2026-06-01T10:00:00.000Z');

const PAYLOAD = {
  turns: [
    { role: 'user', text: 'why did the ingestion service move onto webhooks' },
    { role: 'assistant', text: 'because polling added ninety seconds to every delivery' },
  ],
};

/** A second experience, so the refused acceptance mints its own ids instead of reusing these. */
const REFUSED_PAYLOAD = {
  turns: [
    { role: 'user', text: 'what happened to the nightly reconciliation job' },
    { role: 'assistant', text: 'it moved to the weekly window after the january backlog' },
  ],
};

const OWNERSHIP_SCOPE_NAMES = OWNERSHIP_SCOPES.map(({ role, direction }) =>
  durableRoleScope(role, direction),
);

const vector: Vector = new Array<number>(EMBED_DIMENSION).fill(0.1);

const provider: Provider = {
  embed: (texts) => Promise.resolve(texts.map(() => vector)),
  generate: () => Promise.reject(new Error('intake never generates')),
};

let harness: Neo4jHarness;
let db: SqliteHandle;
let dataDir: string;
let logger: Logger;
let coordinator: PublicationCoordinator;
let deps: ReflectionIntakeDeps;
let episodeId: string;
let turnIds: readonly string[];
/** Where the next publication stops, which is how a prepared-then-refused write is reached. */
let failAt: PublicationBoundary | undefined;

async function push(identity: string, payload: unknown = PAYLOAD): Promise<string> {
  const result = await handleReflection(deps, payload, { identity, now: NOW });
  return result.episode_id;
}

/** Every scope row one endpoint carries, with what each says about its census. */
function scopeRows(endpointId: string): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT relation_class, census_status FROM evidence_scope_versions WHERE endpoint_id = ?',
    )
    .all(endpointId) as { relation_class: string; census_status: string }[];
  return Object.fromEntries(rows.map((row) => [row.relation_class, row.census_status]));
}

function summaryFor(nodeId: string) {
  const context = checkedContext({ now: NOW });
  return ownershipSummaryFor(db, nodeId, ownershipIncidence(db, [nodeId], context), context);
}

beforeAll(async () => {
  harness = await startNeo4jHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'aion-minted-node-census-int-'));
  db = openSqliteHandle({ filePath: join(dataDir, 'aion.sqlite') });
  logger = openLogger({ filePath: join(dataDir, 'aion.jsonl'), level: 'fatal' });
  await runGraphMigrations(harness.driver, db, { embedDimension: EMBED_DIMENSION });

  const backbone = await bootstrapBackbone(harness.driver, { memberName: 'Ryan Huber' });
  coordinator = new PublicationCoordinator({
    driver: harness.driver,
    db,
    logger,
    handlers: [...INSTALLED_PUBLICATION_HANDLERS],
    now: () => NOW,
    boundary: ({ boundary }) => {
      if (boundary === failAt) {
        failAt = undefined;
        throw new Error('interrupted acceptance');
      }
    },
  });
  await coordinator.initialize();
  deps = {
    driver: harness.driver,
    db,
    sessions: new SessionManager(harness.driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    provider,
    logger,
    entropyThreshold: DEFAULTS.redaction.entropyThreshold,
    lanes: new LaneAssigner(DEFAULTS.lanes),
    workerMaxAttempts: DEFAULTS.operational.workerMaxAttempts,
    publications: coordinator,
    acceptHookCapture: true,
  };

  episodeId = await push(WRITING_SESSION);
  turnIds = readSourcePartTurnIds(db, episodeId);
}, 300_000);

afterAll(async () => {
  await stopNeo4jHarness(harness);
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('the census an acceptance proves about the node ids it mints', () => {
  it('counts both turns and the episode, so the acceptance covered every id it drew', () => {
    expect(turnIds).toHaveLength(2);
  });

  it('establishes every ownership scope on the episode and on each of its turns', () => {
    for (const endpointId of [episodeId, ...turnIds]) {
      expect(ownershipCensusEstablished(db, endpointId)).toBe(true);
    }
  });

  it('publishes the first revision of each, at the direction the registry files it under', () => {
    for (const endpointId of [episodeId, ...turnIds]) {
      for (const scope of OWNERSHIP_SCOPE_NAMES) {
        const row = readScopeVersion(db, { endpointId, relationClass: scope });
        expect(row?.censusStatus).toBe('established');
        expect(row?.publishedRevision).toBe(1);
      }
    }
  });

  it('counts nothing on a turn beyond what a reader asks of it', () => {
    const [turnId] = turnIds;
    expect(turnId).toBeDefined();

    // The three an ownership reader consults, and the node's own state, which a judgment binds.
    // The other four support roles stay ABSENT: nothing on this path records the incidence they
    // would be counting, and counting them would mature a fresh turn toward suppression.
    expect(Object.keys(scopeRows(turnId ?? '')).sort()).toEqual(
      [...OWNERSHIP_SCOPE_NAMES, GRAPH_NODE_SCOPE].sort(),
    );
  });

  it('reads the capturing session as the sole owner of the episode and of a turn', () => {
    for (const nodeId of [episodeId, ...turnIds]) {
      const summary = summaryFor(nodeId);

      expect(summary).toMatchObject({
        sessions: [WRITING_SESSION],
        unknownAttribution: false,
        censusEstablished: true,
      });
      expect(ownershipVerdict(summary, WRITING_SESSION)).toBe('own_only');
      expect(ownershipVerdict(summary, OTHER_SESSION)).toBe('shared');
    }
  });

  /**
   * The identity the verdict is keyed on, which is what decides the blast radius of withholding.
   * A push carries its own `session_id` on every hook fire, and the transport identity is the
   * fallback rather than the answer, so the owner has to be the stamped one.
   */
  it('attributes the episode to the session the payload stamped, not to the transport', async () => {
    const stamped = await handleReflection(
      deps,
      { ...PAYLOAD, session_id: STAMPED_SESSION, observations: ['a second capture, stamped'] },
      { identity: 'some-other-transport', now: NOW },
    );

    const summary = summaryFor(stamped.episode_id);
    expect(summary.sessions).toEqual([STAMPED_SESSION]);
    expect(ownershipVerdict(summary, STAMPED_SESSION)).toBe('own_only');
    expect(ownershipVerdict(summary, 'some-other-transport')).toBe('shared');
  });

  /**
   * Three of the seven support censuses, which is three short of an answer. A turn matures toward
   * suppression only when every one of them is counted, and nothing on this path records the
   * incidence the other four would count.
   */
  it('leaves the support reading unknown for a minted turn', () => {
    const [turnId] = turnIds;

    expect(certifyNodeSupport(db, turnId ?? '').support).toBe('unknown');
  });

  it('counts nothing for a push that resolves to a source the records already hold', async () => {
    const before = scopeRows(episodeId);

    const again = await push(WRITING_SESSION);

    expect(again).toBe(episodeId);
    // A reused occurrence minted no id, so it enumerated nothing about one.
    expect(scopeRows(episodeId)).toEqual(before);
    expect(
      readScopeVersion(db, {
        endpointId: episodeId,
        relationClass: OWNERSHIP_SCOPE_NAMES[0] ?? '',
      })?.publishedRevision,
    ).toBe(1);
  });

  /**
   * The other end of the same write, driven through the protocol rather than at the primitive: an
   * acceptance that parked its numbers and was then refused. The numbers are spent, so the next
   * attempt takes fresh ones, and nothing was published, so no reader holding the old token is
   * told anything moved.
   *
   * The refusal is a real one. The acceptance stops after its durable prepare, the coverage epoch
   * its plan was made under moves, and the recovery that meets the new epoch refuses the plan.
   */
  it('releases the parked numbers when a prepared acceptance is refused', async () => {
    failAt = 'prepared';
    await expect(push(WRITING_SESSION, REFUSED_PAYLOAD)).rejects.toThrow();

    const operationId = coordinatorControl(db).pendingOperationId ?? '';
    const record = publicationRecord(db, operationId);
    if (record === undefined) {
      throw new Error('the interrupted acceptance left no prepared record to recover');
    }
    expect(record.state).toBe('prepared');
    const refused = storedPlan(record, intakePublication).data as {
      readonly sourceId: string;
      readonly turnIds: readonly string[];
    };
    const endpoints = [refused.sourceId, ...refused.turnIds];
    expect(refused.turnIds).toHaveLength(2);
    for (const endpointId of endpoints) {
      for (const scope of OWNERSHIP_SCOPE_NAMES) {
        expect(readScopeVersion(db, { endpointId, relationClass: scope })).toMatchObject({
          censusStatus: 'unknown',
          publishedRevision: 0,
          pendingRevision: 1,
          pendingOperationId: operationId,
        });
      }
      expect(ownershipCensusEstablished(db, endpointId)).toBe(false);
    }

    activateCoverageContract(db, { activatedAt: NOW, fieldPolicyVersion: 1 });
    expect(await coordinator.recover()).toMatchObject({
      status: 'deferred',
      reason: 'coverage_epoch_changed',
    });

    for (const endpointId of endpoints) {
      for (const scope of OWNERSHIP_SCOPE_NAMES) {
        expect(readScopeVersion(db, { endpointId, relationClass: scope })).toMatchObject({
          censusStatus: 'unknown',
          publishedRevision: 0,
          allocatedRevision: 1,
          pendingRevision: null,
          pendingOperationId: null,
        });
      }
      expect(ownershipCensusEstablished(db, endpointId)).toBe(false);
    }
  });
});
