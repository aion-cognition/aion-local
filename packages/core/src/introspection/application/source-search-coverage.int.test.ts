import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runSourceIndexJob } from './source-index.js';
import { runSourceSearch, type SourceSearchDeps } from './source-search.js';
import { EvidenceResolver, type EvidenceBatch } from '../../evidence/application/resolver.js';
import type { SourceEvidence } from '../../evidence/application/sources.js';
import type { EvidenceAddress } from '../../evidence/domain/address.js';
import type { RequestBudget } from '../../evidence/domain/budget.js';
import type { EvidenceUse } from '../../evidence/domain/result.js';
import { seedSource } from '../../evidence/test-support/evidence.fixture.js';
import { runGraphMigrations } from '../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { openLogger, type Logger } from '../../infrastructure/logging/logger.js';
import { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PUBLICATION_HANDLERS } from '../../infrastructure/publication/handlers.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import {
  searchGeneration,
  writeSearchDocument,
} from '../../infrastructure/sqlite/source-search-store.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';

/**
 * The coverage epoch outranks the index, proved under a real change rather than off a cursor.
 *
 * A page that reads while the contract activates is a page the substrate no longer stands
 * behind, and calling that an index restart would send a caller back for a page it may not be
 * entitled to at all. The mid-read change here is a real `coverage_activation` publication.
 */

const NOW = new Date('2026-09-08T10:00:00.000Z');
const LATER = new Date('2026-09-08T14:00:00.000Z');
const logger: Logger = openLogger({ filePath: '/dev/null', level: 'error' });

const CONTENT: ReflectionContent = {
  summary: 'the deploy conversation',
  turns: [
    { role: 'user', text: 'the costs qualifier seed missed again', occurred_at: NOW.toISOString() },
    { role: 'assistant', text: 'recorded the qualifier', occurred_at: NOW.toISOString() },
  ],
  observations: ['the runbook was out of date'],
};

let dir: string;
let substrate: RehearsalSubstrate;
let store: SqliteStore;
let coordinator: PublicationCoordinator;
let deps: SourceSearchDeps;
let serial = 0;
/** Runs once inside the page's own evidence read, which is mid-read by construction. */
let midRead: (() => Promise<void>) | undefined;

/** The real resolver, with one hook: the page's evidence read is where a change lands. */
class MidReadResolver extends EvidenceResolver {
  override async resolveSources(
    addresses: readonly EvidenceAddress[],
    context: CheckedReadContext,
    use: EvidenceUse,
    options: { readonly required?: boolean; readonly budget?: RequestBudget } = {},
  ): Promise<EvidenceBatch<SourceEvidence>> {
    const pending = midRead;
    midRead = undefined;
    await pending?.();
    return super.resolveSources(addresses, context, use, options);
  }
}

async function activateThroughCoordinator(): Promise<void> {
  serial += 1;
  store.db.prepare('UPDATE publication_control SET activation_capability_revision = 1').run();
  await coordinator.publish({
    kind: 'coverage_activation',
    operationId: `activation-${String(serial)}`,
    payload: {
      expectedEpoch: readCurrentCoverageContract(store.db)?.epoch,
      capabilityRevision: 1,
      fieldPolicyVersion: 1,
    },
  });
}

function replaceIndexedDocument(): void {
  writeSearchDocument(store.db, {
    sourceId: 'episode-1',
    partKind: 'turn',
    partOrdinal: 0,
    contentDigest: `replaced-${String(searchGeneration(store.db))}`,
    body: 'a different reading of the same part',
    truncated: false,
    indexedBytes: 35,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-source-coverage-int-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  store = new SqliteStore({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, store.db, { embedDimension: 3 });
  coordinator = new PublicationCoordinator({
    driver: substrate.harness.driver,
    db: store.db,
    logger,
    handlers: [...PUBLICATION_HANDLERS],
    now: () => NOW,
  });
  await coordinator.initialize();
  await activateThroughCoordinator();
  seedSource(store.db, {
    sourceId: 'episode-1',
    sessionId: 'session-1',
    identity: 'agent-1',
    content: CONTENT,
    turnIds: ['turn-a', 'turn-b'],
    now: NOW,
  });
  deps = {
    db: store.db,
    resolver: new MidReadResolver({ driver: substrate.harness.driver, db: store.db, logger }),
    now: () => LATER,
  };
  expect((await runSourceIndexJob({ ...deps, logger }, { sourceId: 'episode-1' })).status).toBe(
    'indexed',
  );
}, 90_000);

afterAll(async () => {
  store.close();
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  midRead = undefined;
});

describe('a coverage contract that activates while a page is being read', () => {
  it('answers with the coverage refusal, not with an index restart', async () => {
    // Both change under the read, which is what the precedence is for: the epoch is checked
    // first, so the caller is told the contract moved rather than asked to page again.
    midRead = async () => {
      await activateThroughCoordinator();
      replaceIndexedDocument();
    };

    const outcome = await runSourceSearch(deps, { query: 'qualifier' });

    expect(outcome).toMatchObject({
      status: 'coverage_refused',
      refusal: { reason: 'coverage_changed' },
    });
  });

  it('answers a replacement alone with an index restart', async () => {
    midRead = () => {
      replaceIndexedDocument();
      return Promise.resolve();
    };

    const outcome = await runSourceSearch(deps, { query: 'qualifier' });

    expect(outcome).toEqual({ status: 'restart_required', reason: 'index_generation_changed' });
  });

  it('answers an untouched page with its results and its coverage', async () => {
    const outcome = await runSourceSearch(deps, { query: 'qualifier' });

    expect(outcome).toMatchObject({
      status: 'results',
      coverage: { status: 'supported', history_since: NOW.toISOString() },
    });
  });
});
