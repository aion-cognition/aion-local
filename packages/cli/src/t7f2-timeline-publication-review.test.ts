import * as core from '@aion/core';
import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';

import { Substrate, type SubstrateCommand } from './substrate.js';
import { runTimelineCommand } from './timeline.js';
import {
  seedSource,
  commitSourceState,
} from '../../core/src/evidence/test-support/evidence.fixture.js';
import {
  prepareCoverageContract,
  activateCoverageContract,
} from '../../core/src/infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../core/src/infrastructure/sqlite/database.js';
import {
  preparePublicationIntent,
  acknowledgePublicationIntent,
} from '../../core/src/infrastructure/sqlite/publication-intents.js';
import {
  prepareReferenceAcceptance,
  acknowledgeReferenceAcceptance,
} from '../../core/src/reflection/application/reference-acceptance.js';

const state = vi.hoisted(() => ({
  substrate: undefined as Substrate | undefined,
  errors: [] as string[],
  output: [] as string[],
}));
vi.mock('./substrate.js', async (original) => {
  const actual = await original<Record<string, unknown>>();
  return {
    ...actual,
    withSubstrate: async (command: SubstrateCommand<unknown>) => {
      if (state.substrate === undefined) {
        throw new Error('test substrate was not installed');
      }
      return command.run(state.substrate, command.parse(command.argv));
    },
  };
});
vi.mock('./output.js', () => ({
  stdoutWriter: () => undefined,
  stderrWriter: (line: string) => state.errors.push(line),
}));

const START = new Date('2026-09-01T10:00:00.000Z');
let dir: string;
let store: SqliteStore;
let logger: ReturnType<typeof core.openLogger>;
const driver = { executeQuery: async () => ({ records: [] }) } as unknown as Driver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-cli-source-review-'));
  store = new SqliteStore({ filePath: join(dir, 'db.sqlite') });
  prepareCoverageContract(store.db, 1);
  activateCoverageContract(store.db, { activatedAt: START, fieldPolicyVersion: 1 });
  logger = core.openLogger({ filePath: join(dir, 'log.jsonl'), level: 'error' });
  state.substrate = new Substrate(core.DEFAULTS, 'review', (line) => state.output.push(line));
  state.errors = [];
  state.output = [];
  vi.spyOn(state.substrate, 'db').mockReturnValue(store.db);
  vi.spyOn(state.substrate, 'connection').mockReturnValue({ driver } as core.GraphConnection);
  vi.spyOn(state.substrate, 'logger').mockReturnValue(logger);
  vi.spyOn(core, 'loadEpisodeContext').mockResolvedValue(undefined);
  vi.spyOn(core, 'fetchNodeProvenance').mockResolvedValue(undefined);
  vi.spyOn(core, 'fetchNodeEdges').mockResolvedValue({ edges: [], complete: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  logger.flush();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it('shows the publication sequence and both acknowledgment clocks for accepted references', async () => {
  for (const id of ['source', 'target']) {
    seedSource(store.db, {
      sourceId: id,
      sessionId: 'session',
      identity: id,
      content: { observations: [id] },
      now: START,
    });
  }
  const known = '2026-09-06T10:00:00.000Z';
  const observed = '2026-09-05T10:00:00.000Z';
  commitSourceState(store.db, {
    sourceId: 'source',
    stateKind: 'unforgotten',
    operationId: 'prior-clock',
    at: new Date(known),
  });
  store.db
    .prepare("UPDATE sqlite_sequence SET seq = ? WHERE name='publication_intents'")
    .run(9007199254740992n);
  const acceptance = {
    sourceId: 'source',
    deliveryKey: 'timeline-delivery',
    operationId: 'timeline-reference-publication',
    acceptedAt: '2026-09-04T10:00:00.000Z',
    targets: [{ id: 'target', kind: 'derived_from' as const, targetClass: 'source' as const }],
  };
  const version = store.db
    .transaction(() => {
      preparePublicationIntent(store.db, {
        operationId: acceptance.operationId,
        kind: 'stated_references',
        payloadDigest: 'fixture',
        payloadJson: '{}',
        expectedJson: '{}',
        affectedScopesJson: '[]',
        preparedActionsJson: '{}',
        createdAt: new Date(observed),
      });
      return prepareReferenceAcceptance(store.db, acceptance);
    })
    .immediate();
  const receipt = store.db
    .transaction(() => {
      acknowledgeReferenceAcceptance(store.db, {
        ...acceptance,
        referenceVersion: version,
        knownFrom: known,
        observedAckAt: observed,
      });
      return acknowledgePublicationIntent(store.db, {
        operationId: acceptance.operationId,
        resultDigest: 'fixture',
        resultJson: '{}',
        observedAckAt: new Date(observed),
      });
    })
    .immediate();
  expect(receipt.knownFrom).toBe(known);
  expect(receipt.clockClamped).toBe(true);
  expect(await runTimelineCommand(['source', '--json'])).toBe(0);
  const rendered = state.output.join('');
  expect.soft(rendered).toContain(known);
  expect.soft(rendered).toContain(observed);
  expect(rendered).toContain(receipt.sequence);
});
