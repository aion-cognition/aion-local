import type { Driver } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSourceIndexJob } from './source-index.js';
import { runSourceInspection } from './source-inspect.js';
import { runSourceSearch, type SourceSearchDeps } from './source-search.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import { commitSourceState, seedSource } from '../../evidence/test-support/evidence.fixture.js';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '../../infrastructure/sqlite/coverage-contract.js';
import { SqliteStore } from '../../infrastructure/sqlite/database.js';
import { withoutFts5 } from '../../infrastructure/sqlite/fts-capability.fixture.js';
import { transitionSourceResidency } from '../../infrastructure/sqlite/source-lifecycle.js';
import {
  searchGeneration,
  writeSearchDocument,
} from '../../infrastructure/sqlite/source-search-store.js';
import type { ReflectionContent } from '../../reflection/domain/content.js';
import { SOURCE_SEARCH_LIMITS } from '../domain/source-search.js';

const H = new Date('2026-09-01T00:00:00.000Z');
const NOW = new Date('2026-09-08T10:00:00.000Z');
const LATER = new Date('2026-09-08T14:00:00.000Z');

const CONTENT: ReflectionContent = {
  summary: 'the deploy conversation',
  turns: [
    { role: 'user', text: 'the costs qualifier seed missed again', occurred_at: NOW.toISOString() },
    { role: 'assistant', text: 'recorded the qualifier', occurred_at: NOW.toISOString() },
  ],
  observations: ['the runbook was out of date'],
};

const logger = { warn: () => undefined, debug: () => undefined };

function stubDriver(): Driver {
  return { executeQuery: () => Promise.resolve({ records: [] }) } as unknown as Driver;
}

describe('archive search and inspection', () => {
  let dir: string;
  let store: SqliteStore;
  let deps: SourceSearchDeps & { readonly logger: typeof logger };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-source-search-'));
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
    prepareCoverageContract(store.db, 1);
    activateCoverageContract(store.db, { activatedAt: H, fieldPolicyVersion: 1 });
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
      resolver: new EvidenceResolver({ driver: stubDriver(), db: store.db, logger }),
      now: () => LATER,
      logger,
    };
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function index(sourceId = 'episode-1'): Promise<void> {
    const outcome = await runSourceIndexJob(deps, { sourceId });
    expect(outcome.status).toBe('indexed');
  }

  it('finds a raw phrase that no claim or narrative holds', async () => {
    await index();
    const outcome = await runSourceSearch(deps, { query: 'costs qualifier' });

    expect(outcome.status).toBe('results');
    if (outcome.status !== 'results') {
      return;
    }
    expect(outcome.results).toHaveLength(1);
    const [hit] = outcome.results;
    expect(hit?.sourceId).toBe('episode-1');
    expect(hit?.partKind).toBe('turn');
    expect(hit?.ordinal).toBe(0);
    expect(hit?.turnId).toBe('turn-a');
    expect(hit?.role).toBe('user');
    expect(hit?.excerpt.text).toContain('costs qualifier');
    expect(hit?.excerpt.start).toBe(0);
    expect(outcome.coverage.status).toBe('supported');
  });

  it('answers the same after the raw projection is evicted', async () => {
    await index();
    transitionSourceResidency(store.db, {
      sourceId: 'episode-1',
      state: 'evicted',
      operationId: 'evict-1',
      transitionedAt: LATER,
    });
    const outcome = await runSourceSearch(deps, { query: 'costs qualifier' });

    expect(outcome.status).toBe('results');
    if (outcome.status !== 'results') {
      return;
    }
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.residency).toBe('evicted');
    expect(outcome.results[0]?.excerpt.text).toContain('costs qualifier');
  });

  it('withholds a forgotten source from search while the index still holds it', async () => {
    await index();
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: LATER,
    });
    const outcome = await runSourceSearch(deps, { query: 'costs qualifier' });

    expect(outcome.status).toBe('results');
    if (outcome.status !== 'results') {
      return;
    }
    expect(outcome.results).toEqual([]);
    expect(outcome.corpus.withheld).toBe(1);
    expect(outcome.corpus.examined).toBe(1);
  });

  it('reindexes a forgotten source through the internal purpose', async () => {
    commitSourceState(store.db, {
      sourceId: 'episode-1',
      stateKind: 'forgotten',
      operationId: 'forget-1',
      at: NOW,
    });
    const outcome = await runSourceIndexJob(deps, { sourceId: 'episode-1' });

    expect(outcome.status).toBe('indexed');
    if (outcome.status !== 'indexed') {
      return;
    }
    expect(outcome.documents).toBe(3);
    expect(outcome.complete).toBe(true);
  });

  it('discloses an incomplete corpus even when the search matched nothing', async () => {
    await index();
    writeSearchDocument(store.db, {
      sourceId: 'episode-1',
      partKind: 'turn',
      partOrdinal: 0,
      contentDigest: 'cut',
      body: 'the costs',
      truncated: true,
      indexedBytes: 9,
    });
    const outcome = await runSourceSearch(deps, { query: 'nowhere' });

    expect(outcome.status).toBe('results');
    if (outcome.status !== 'results') {
      return;
    }
    expect(outcome.results).toEqual([]);
    expect(outcome.corpus.truncatedDocuments).toBe(1);
    expect(outcome.coverage.gaps).toContainEqual(
      expect.objectContaining({ reason: 'bounded_read' }),
    );
  });

  it('excludes a document appended under a running pagination', async () => {
    await index();
    const first = await runSourceSearch(deps, { query: 'the', limit: 1 });
    expect(first.status).toBe('results');
    if (first.status !== 'results' || first.continuation === undefined) {
      throw new Error('the first page continues');
    }
    seedSource(store.db, {
      sourceId: 'episode-2',
      sessionId: 'session-1',
      identity: 'agent-1',
      content: { summary: 'later', turns: [{ role: 'user', text: 'the later arrival' }] },
      turnIds: ['turn-c'],
      now: LATER,
    });
    await index('episode-2');

    const second = await runSourceSearch(deps, {
      query: 'the',
      limit: 5,
      cursor: first.continuation,
    });
    expect(second.status).toBe('results');
    if (second.status !== 'results') {
      return;
    }
    expect(second.results.every((hit) => hit.sourceId === 'episode-1')).toBe(true);
  });

  it('returns restart_required when a document is replaced under a cursor', async () => {
    await index();
    const first = await runSourceSearch(deps, { query: 'the', limit: 1 });
    if (first.status !== 'results' || first.continuation === undefined) {
      throw new Error('the first page continues');
    }
    writeSearchDocument(store.db, {
      sourceId: 'episode-1',
      partKind: 'turn',
      partOrdinal: 0,
      contentDigest: 'replaced',
      body: 'a different reading of the same part',
      truncated: false,
      indexedBytes: 35,
    });
    expect(searchGeneration(store.db)).toBe(2);

    const second = await runSourceSearch(deps, { query: 'the', cursor: first.continuation });
    expect(second).toEqual({ status: 'restart_required', reason: 'index_generation_changed' });
  });

  it('refuses a continuation that belongs to a different query', async () => {
    await index();
    const first = await runSourceSearch(deps, { query: 'the', limit: 1 });
    if (first.status !== 'results' || first.continuation === undefined) {
      throw new Error('the first page continues');
    }
    const other = await runSourceSearch(deps, { query: 'qualifier', cursor: first.continuation });
    expect(other).toMatchObject({ status: 'invalid_request', field: 'cursor' });
  });

  it('refuses a query with nothing in it to look for, before it reads anything', async () => {
    expect(await runSourceSearch(deps, { query: '   ' })).toMatchObject({
      status: 'invalid_request',
      field: 'query',
    });
    expect(await runSourceSearch(deps, { query: '"unclosed' })).toMatchObject({
      status: 'invalid_request',
      field: 'query',
    });
    expect(
      await runSourceSearch(deps, {
        query: 'x'.repeat(SOURCE_SEARCH_LIMITS.maxQueryCharacters + 1),
      }),
    ).toMatchObject({ status: 'invalid_request', field: 'query' });
    expect(await runSourceSearch(deps, { query: 'costs', limit: 500 })).toMatchObject({
      status: 'invalid_request',
      field: 'limit',
    });
  });

  it('refuses a knowledge time nobody can hold', async () => {
    const outcome = await runSourceSearch(deps, {
      query: 'costs',
      knewAt: '2026-12-01T00:00:00.000Z',
    });
    expect(outcome).toMatchObject({ status: 'coverage_refused' });
    if (outcome.status !== 'coverage_refused') {
      return;
    }
    expect(outcome.refusal.reason).toBe('future_knowledge');
  });

  it('returns a typed unavailable when the capability is missing, and indexes nothing', async () => {
    const missing = { ...deps, db: withoutFts5(store.db) };
    const search = await runSourceSearch(missing, { query: 'costs' });
    expect(search).toMatchObject({ status: 'search_unavailable', cause: 'fts5_unavailable' });

    const job = await runSourceIndexJob(missing, { sourceId: 'episode-1' });
    expect(job).toMatchObject({ status: 'search_unavailable', cause: 'fts5_unavailable' });
  });

  describe('inspection', () => {
    it('returns the ordered parts of a source by its own id', async () => {
      const outcome = await runSourceInspection(deps, { id: 'episode-1' });
      expect(outcome.status).toBe('source');
      if (outcome.status !== 'source') {
        return;
      }
      expect(outcome.parts.map((part) => part.partKind)).toEqual(['observation', 'turn', 'turn']);
      expect(outcome.continuation).toBeUndefined();
      expect(outcome.sessionId).toBe('session-1');
    });

    it('pages the parts and hands back the suffix intact', async () => {
      const first = await runSourceInspection(deps, { id: 'episode-1', limit: 1 });
      if (first.status !== 'source' || first.continuation === undefined) {
        throw new Error('a one-part page continues');
      }
      const second = await runSourceInspection(deps, {
        id: 'episode-1',
        cursor: first.continuation,
      });
      if (second.status !== 'source') {
        throw new Error('the suffix answers');
      }
      expect(second.parts).toHaveLength(2);
      expect(second.continuation).toBeUndefined();
    });

    it('pages a part larger than one response and rejoins it exactly', async () => {
      // Four characters per repeat, so the part is well past the 64 KiB response budget and the
      // multi-byte characters make a naive byte cut land mid-sequence.
      const long = 'aé😀b'.repeat(20_000);
      seedSource(store.db, {
        sourceId: 'episode-long',
        sessionId: 'session-1',
        identity: 'agent-1',
        content: { summary: 'long', turns: [{ role: 'user', text: long }] },
        turnIds: ['turn-long'],
        now: NOW,
      });

      // `user: ` is the captured role prefix the reconstruction puts in front of a turn.
      const captured = `user: ${long}`;
      let cursor: string | undefined;
      let rejoined = '';
      let pages = 0;
      for (; pages < 20; pages += 1) {
        const outcome = await runSourceInspection(deps, {
          id: 'episode-long',
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (outcome.status !== 'source') {
          throw new Error('every page of a verified source answers');
        }
        const bytes = outcome.parts.reduce(
          (total, part) => total + Buffer.byteLength(part.text, 'utf8'),
          0,
        );
        expect(bytes).toBeLessThanOrEqual(SOURCE_SEARCH_LIMITS.maxResponseTextBytes);
        for (const part of outcome.parts) {
          // The offsets are the part's own, so the slice they name is the text that came back.
          expect(part.text).toBe(captured.slice(part.textStart, part.textEnd));
          expect(part.textStart).toBe(rejoined.length);
          rejoined += part.text;
        }
        cursor = outcome.continuation;
        if (cursor === undefined) {
          break;
        }
      }

      expect(pages).toBeGreaterThan(0);
      expect(cursor).toBeUndefined();
      expect(rejoined).toBe(captured);
    });

    it('resolves an original turn id to the part that holds it', async () => {
      const outcome = await runSourceInspection(deps, { id: 'turn-b' });
      if (outcome.status !== 'source') {
        throw new Error('an original turn id resolves');
      }
      expect(outcome.parts).toEqual([expect.objectContaining({ ordinal: 1, turnId: 'turn-b' })]);
    });

    it('names an id nothing maps rather than answering empty', async () => {
      const outcome = await runSourceInspection(deps, { id: 'nobody' });
      expect(outcome).toMatchObject({ status: 'unavailable', residency: 'unknown-mapping' });
    });

    it('withholds a forgotten source and says the substrate answered', async () => {
      commitSourceState(store.db, {
        sourceId: 'episode-1',
        stateKind: 'forgotten',
        operationId: 'forget-1',
        at: NOW,
      });
      const outcome = await runSourceInspection(deps, { id: 'episode-1' });
      expect(outcome).toMatchObject({ status: 'unavailable', evidence: 'not-found-in-coverage' });
    });
  });
});
