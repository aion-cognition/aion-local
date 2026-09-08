import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activateSourceManifest,
  writeSourceManifest,
  type SourceManifest,
  type SourceManifestInput,
} from './source-manifest.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import {
  listIngestAfter,
  readIntakeWatermark,
} from '../../infrastructure/sqlite/migration-cohorts.js';
import {
  listGenerations,
  listStageWork,
  readActiveGeneration,
  readGeneration,
} from '../../infrastructure/sqlite/processing-generations.js';
import {
  listReferenceBatches,
  readSourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import {
  captureOrderValue,
  listEvidenceAcknowledgments,
  readSessionRemainder,
} from '../../infrastructure/sqlite/source-lifecycle.js';
import { occurrenceCandidates } from '../../infrastructure/sqlite/source-occurrence.js';
import { prepareEpisode, type ReflectionContent } from '../domain/content.js';
import { PIPELINE_VERSION } from '../domain/version.js';

const NOW = new Date('2026-09-08T06:00:00.000Z');
const STAGES = ['entities', 'cognitive'];

const CONTENT: ReflectionContent = {
  turns: [
    { role: 'user', text: 'why did the sync key on id_slug' },
    { role: 'assistant', text: 'the external ids churn' },
  ],
  tool_executions: [{ tool: 'bash', status: 'ok' }],
  observations: ['keyed the sync on id_slug'],
};

let dir: string;
let store: SqliteStore;

function manifestInput(overrides: Partial<SourceManifestInput> = {}): SourceManifestInput {
  return {
    sourceId: 'source-1',
    sessionId: 'session-a',
    identity: 'member-1',
    prepared: prepareEpisode(CONTENT, NOW),
    payload: CONTENT,
    references: undefined,
    lane: undefined,
    origin: { channel: 'mcp' },
    pipelineVersion: PIPELINE_VERSION,
    operationKey: 'operation-1',
    readiness: { policyRevision: 3, stageNames: STAGES },
    now: NOW,
    ...overrides,
  };
}

function write(input: SourceManifestInput, turnIds: readonly string[]): SourceManifest {
  return store.db.transaction((): SourceManifest =>
    writeSourceManifest(store.db, input, turnIds),
  )();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-manifest-'));
  store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the durable prepare of one acceptance', () => {
  it('refuses outside the acceptance transaction', () => {
    expect(() => writeSourceManifest(store.db, manifestInput(), ['turn-1', 'turn-2'])).toThrow(
      /acceptance transaction/,
    );
  });

  it('writes the archive row, the identity records, the ingest position and generation one', () => {
    const manifest = write(manifestInput(), ['turn-1', 'turn-2']);

    expect(manifest.archived).toBe(true);
    expect(manifest.processingGeneration).toBe(1);
    expect(manifest.referenceVersion).toBe(1);
    expect(getExperienceByEpisode(store.db, 'source-1')?.contentHash).toBe(
      prepareEpisode(CONTENT, NOW).contentHash,
    );
    expect(readSourceRecord(store.db, 'source-1')).toMatchObject({
      verificationStatus: 'verified',
      captureOrderValue: captureOrderValue(manifest.ingestPosition),
      captureOrderBasis: 'archive_acceptance',
    });
    expect(
      occurrenceCandidates(store.db, {
        identityHash: manifest.identityHash,
        sessionId: 'session-a',
      }),
    ).toEqual(['source-1']);
    expect(readIntakeWatermark(store.db)).toBe(manifest.ingestPosition);
    expect(listReferenceBatches(store.db, 'source-1')).toHaveLength(1);
  });

  it('records a part for every turn, observation and tool execution', () => {
    write(manifestInput(), ['turn-1', 'turn-2']);

    const parts = store.db
      .prepare(
        'SELECT part_kind, ordinal, turn_id FROM source_parts WHERE source_id = ? ORDER BY part_kind, ordinal',
      )
      .all('source-1');
    expect(parts).toEqual([
      { part_kind: 'observation', ordinal: 0, turn_id: null },
      { part_kind: 'tool_execution', ordinal: 0, turn_id: null },
      { part_kind: 'turn', ordinal: 0, turn_id: 'turn-1' },
      { part_kind: 'turn', ordinal: 1, turn_id: 'turn-2' },
    ]);
  });

  it('leaves generation one unclaimable until the acknowledgment activates it', () => {
    write(manifestInput(), ['turn-1', 'turn-2']);

    expect(readGeneration(store.db, 'source-1', 1)?.state).toBe('allocated');
    expect(readActiveGeneration(store.db, 'source-1')).toBeUndefined();
    expect(listStageWork(store.db, 'source-1', 1).map((row) => row.stageName)).toEqual(
      [...STAGES].sort(),
    );
  });

  it('records an inventory obligation rather than zero work when no policy exists yet', () => {
    write(manifestInput({ readiness: undefined }), ['turn-1', 'turn-2']);

    const owed = store.db
      .prepare('SELECT kind, work_key, state FROM source_work WHERE source_id = ?')
      .all('source-1');
    expect(owed).toEqual([
      { kind: 'inventory', work_key: 'inventory:pending_policy', state: 'pending' },
    ]);
  });

  it('owes the raw index and the semantic processing of the accepted batch separately', () => {
    const manifest = write(manifestInput(), ['turn-1', 'turn-2']);

    expect(listEvidenceAcknowledgments(store.db, 'source-1')).toEqual([
      {
        sourceId: 'source-1',
        referenceVersion: manifest.referenceVersion,
        effectKind: 'semantic_processing',
        state: 'owed',
        completedAt: null,
      },
      {
        sourceId: 'source-1',
        referenceVersion: manifest.referenceVersion,
        effectKind: 'source_index',
        state: 'owed',
        completedAt: null,
      },
    ]);
  });

  it('resumes the same rows on a retry of the same acceptance', () => {
    const first = write(manifestInput(), ['turn-1', 'turn-2']);
    const second = write(manifestInput(), ['turn-1', 'turn-2']);

    expect(second.archived).toBe(false);
    expect(second.referenceVersion).toBe(first.referenceVersion);
    expect(second.ingestPosition).toBe(first.ingestPosition);
    expect(listReferenceBatches(store.db, 'source-1')).toHaveLength(1);
    expect(listIngestAfter(store.db, 0, 10)).toHaveLength(1);
    expect(second.processingGeneration).toBe(first.processingGeneration);
    expect(listGenerations(store.db, 'source-1')).toHaveLength(1);
  });

  it('gives a forgotten source its own occurrence, generation and reference history', () => {
    write(manifestInput(), ['turn-1', 'turn-2']);
    const replacement = write(
      manifestInput({ sourceId: 'source-2', operationKey: 'operation-2' }),
      ['turn-3', 'turn-4'],
    );

    expect(replacement.processingGeneration).toBe(1);
    expect(replacement.referenceVersion).toBe(1);
    expect(listReferenceBatches(store.db, 'source-1')).toHaveLength(1);
    expect(readGeneration(store.db, 'source-2', 1)).toBeDefined();
    // The bytes are shared through the occurrence record: the re-push conflicts on the archive
    // key and writes no second row, so both occurrences verify against the same one.
    expect(readSourceRecord(store.db, 'source-2')?.canonicalArchiveId).toBe(
      readSourceRecord(store.db, 'source-1')?.canonicalArchiveId,
    );
    expect(readSourceRecord(store.db, 'source-2')?.verificationStatus).toBe('verified');
  });
});

describe('the acknowledgment half', () => {
  it('activates the inventory and moves the session remainder together', () => {
    const manifest = write(manifestInput(), ['turn-1', 'turn-2']);
    store.db.transaction((): void => {
      activateSourceManifest(store.db, {
        sourceId: 'source-1',
        processingGeneration: manifest.processingGeneration,
        sessionId: 'session-a',
        captureOrderValue: captureOrderValue(manifest.ingestPosition),
        now: NOW,
      });
    })();

    expect(readActiveGeneration(store.db, 'source-1')?.processingGeneration).toBe(1);
    expect(readSessionRemainder(store.db, 'session-a')).toBe(
      captureOrderValue(manifest.ingestPosition),
    );
  });

  it('refuses outside the acknowledgment transaction', () => {
    const manifest = write(manifestInput(), ['turn-1', 'turn-2']);

    expect(() =>
      activateSourceManifest(store.db, {
        sourceId: 'source-1',
        processingGeneration: manifest.processingGeneration,
        sessionId: 'session-a',
        captureOrderValue: captureOrderValue(manifest.ingestPosition),
        now: NOW,
      }),
    ).toThrow(/acknowledgment transaction/);
  });

  it('never moves the remainder backwards', () => {
    const first = write(manifestInput(), ['turn-1', 'turn-2']);
    const second = write(manifestInput({ sourceId: 'source-2', operationKey: 'operation-2' }), [
      'turn-3',
      'turn-4',
    ]);
    store.db.transaction((): void => {
      activateSourceManifest(store.db, {
        sourceId: 'source-2',
        processingGeneration: second.processingGeneration,
        sessionId: 'session-a',
        captureOrderValue: captureOrderValue(second.ingestPosition),
        now: NOW,
      });
      activateSourceManifest(store.db, {
        sourceId: 'source-1',
        processingGeneration: first.processingGeneration,
        sessionId: 'session-a',
        captureOrderValue: captureOrderValue(first.ingestPosition),
        now: NOW,
      });
    })();

    expect(readSessionRemainder(store.db, 'session-a')).toBe(
      captureOrderValue(second.ingestPosition),
    );
  });
});
