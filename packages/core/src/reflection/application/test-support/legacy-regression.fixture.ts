import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, vi, expect } from 'vitest';
import { z } from 'zod';

import { EvidenceResolver } from '../../../evidence/application/resolver.js';
import { seedSource } from '../../../evidence/test-support/evidence.fixture.js';
import { runGraphMigrations } from '../../../infrastructure/graph/migrations.js';
import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from '../../../infrastructure/graph/test-support/consolidation-rehearsal.fixture.js';
import { LegacyNarrativeGraph } from '../../../infrastructure/graph/test-support/legacy-narrative-regression.fixture.js';
import { clearGraphNodes } from '../../../infrastructure/graph/test-support/neo4j-harness.fixture.js';
import { openLogger } from '../../../infrastructure/logging/logger.js';
import type { Provider, Vector } from '../../../infrastructure/providers/types.js';
import { PublicationCoordinator } from '../../../infrastructure/publication/coordinator.js';
import { PublicationOperation } from '../../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../../infrastructure/sqlite/database.js';
import { acknowledgeFamilySelection } from '../../../infrastructure/sqlite/family-selection.js';
import { prepareFamilyAdvance, acknowledgeFamilyAdvance } from '../family-fence.js';
import { INSTALLED_PUBLICATION_HANDLERS } from '../installed-publications.js';
import type { NarrativeCleanupDeps } from '../narrative-cleanup.js';

export const NOW = new Date('2026-04-02T12:00:00Z');
export const EMBED_DIMENSION = 8;
export const FIRST_SENTENCE = 'The pair shipped the reflection worker.';
export const SECOND_SENTENCE = 'They gated its re-run on the ledger key.';
export const SESSION_ID = 'mcp-transport-session-1';
export const OTHER_SESSION_ID = 'mcp-transport-session-2';
export const OUTPUT = {
  sentences: [
    { text: FIRST_SENTENCE, source_ids: ['S1'] },
    { text: SECOND_SENTENCE, source_ids: ['S2'] },
  ],
};
export let graph: LegacyNarrativeGraph;
export let store: SqliteStore;
export let deps: NarrativeCleanupDeps;
export let generate: ReturnType<typeof vi.fn<Provider['generate']>>;
export let embed: ReturnType<typeof vi.fn<(texts: readonly string[]) => Promise<Vector[]>>>;
let substrate: RehearsalSubstrate;
let dir: string;
let testIndex = 0;

// Explicitly seed a pre-existing legacy preference. The writer under test still uses its real
// coordinator, graph transaction, receipt, source checks and acknowledgment without mocks.
const baseline = new PublicationOperation({
  kind: 'topology_update',
  effectKinds: [],
  payload: z.object({ sessionId: z.string() }),
  data: z.object({ sessionId: z.string() }),
  result: z.object({}),
  prepare: async ({ db }, data) => ({
    data,
    scopes: [],
    effects: [],
    expected: {
      coverageEpoch: readCurrentCoverageContract(db)?.epoch ?? 'missing',
      evidence: buildEvidenceRevision([]),
      sources: [],
      heads: [],
    },
  }),
  check: async () => ({ status: 'valid' }),
  applyGraph: async () => ({}),
  prepareSqlite: (ctx, data) => {
    prepareFamilyAdvance(ctx.db, data.sessionId, ctx.operationId, NOW);
  },
  acknowledgeSqlite: (ctx, data) => {
    acknowledgeFamilySelection(ctx.db, {
      sessionId: data.sessionId,
      family: 'legacy_session_overview',
      expectedVersion: 0,
      operationId: ctx.operationId,
    });
    acknowledgeFamilyAdvance(ctx.db, data.sessionId, ctx.operationId, ctx.knownFrom);
  },
  discardSqlite: () => undefined,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aion-legacy-regression-'));
  substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'admission.sqlite') });
  graph = new LegacyNarrativeGraph(substrate.harness.driver);
}, 180_000);
beforeEach(async () => {
  await clearGraphNodes(graph.driver);
  store = new SqliteStore({ filePath: join(dir, `case-${String(testIndex++)}.sqlite`) });
  await runGraphMigrations(graph.driver, store.db, { embedDimension: EMBED_DIMENSION });
  const logger = openLogger({ filePath: '/dev/null', level: 'fatal' });
  const publications = new PublicationCoordinator({
    driver: graph.driver,
    db: store.db,
    logger,
    now: () => NOW,
    handlers: [
      ...INSTALLED_PUBLICATION_HANDLERS.filter((handler) => handler.kind !== 'topology_update'),
      baseline,
    ],
  });
  await publications.initialize();
  embed = vi.fn(async (texts: readonly string[]) =>
    texts.map(() => Array.from({ length: EMBED_DIMENSION }, (_, slot) => 1 / (slot + 1))),
  );
  generate = vi.fn(async () => OUTPUT);
  deps = {
    driver: graph.driver,
    db: store.db,
    logger,
    publications,
    resolver: new EvidenceResolver({ driver: graph.driver, db: store.db, logger, publications }),
    provider: { embed, generate },
  };
  await seedSession(SESSION_ID);
  await seedSession(OTHER_SESSION_ID);
});
afterEach(() => {
  store.close();
});
afterAll(async () => {
  await stopRehearsalSubstrate(substrate);
  rmSync(dir, { recursive: true, force: true });
});

export async function seedSession(sessionId: string): Promise<void> {
  await graph.seedNode(sessionId, ['Session', 'AionNode']);
  expect(
    (
      await deps.publications?.publish({
        kind: 'topology_update',
        operationId: `seed-legacy:${sessionId}`,
        payload: { sessionId },
      })
    )?.status,
  ).toBe('acknowledged');
}

export async function seedEpisode(
  id: string,
  writtenAt: string,
  sessionId = SESSION_ID,
  text = `body of ${id}`,
): Promise<void> {
  const at = new Date(writtenAt);
  await graph.seedNode(id, ['Episode', 'Memory', 'AionNode'], {
    text,
    session_id: sessionId,
    occurred_at: at,
    tx_from: at,
  });
  await graph.seedEdge('PARTICIPATES_IN', id, sessionId);
  seedSource(store.db, {
    sourceId: id,
    sessionId,
    identity: sessionId,
    content: { observations: [text] },
    now: at,
  });
}

export async function seedDecision(id: string, episodeId: string, text: string): Promise<void> {
  await graph.seedNode(id, ['Decision', 'Memory', 'AionNode'], { text });
  await graph.seedEdge('EXTRACTED_FROM', id, episodeId);
}
