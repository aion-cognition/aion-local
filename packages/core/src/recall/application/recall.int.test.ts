import { packBuckets } from '@aion/protocol';
import { describe, expect, it } from 'vitest';

import { CueCache } from './cues.js';
import { handleRecall, type RecallDeps } from './recall.js';
import {
  axis,
  BEFORE_ANYTHING,
  CUE,
  db,
  deps,
  harness,
  provider,
  push,
  QUERY,
  READ_SESSION,
  RECALLED_AT,
  REQUIRED_STAGES,
  substrateId,
  unrelatedEpisodeId,
  webhooksEpisodeId,
  WEBHOOKS_OBSERVATION,
} from './test-support/recall-int.fixture.js';
import { SUBSTRATE_NAME } from '../../infrastructure/graph/backbone.js';
import { withCurrency } from '../../infrastructure/graph/read-modes.js';
import { fulltextSeeds, vectorSeeds } from '../../infrastructure/graph/seed-queries.js';
import { getLastPack } from '../../infrastructure/sqlite/last-pack.js';
import {
  PACK_METHODS,
  packMethodCounters,
  type PackMethod,
} from '../../infrastructure/sqlite/method-counters.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import {
  completeSourceWork,
  readActiveGeneration,
  stageWorkId,
} from '../../infrastructure/sqlite/processing-generations.js';
import { orchestratorLedgerKey } from '../../reflection/application/orchestrator.js';
import { PIPELINE_VERSION } from '../../reflection/domain/version.js';

describe('recall over a substrate written by the real intake path', () => {
  it('returns the episode the query is about, explained by the strategy that found it', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    const hit = pack.episodes?.find((item) => item.id === webhooksEpisodeId);
    expect(hit?.content).toContain(WEBHOOKS_OBSERVATION);
    expect(['vector', 'bm25', 'recency']).toContain(hit?.rationale.method);
    expect(hit?.currency).toBe('current');
  });

  /**
   * The spread still reaches it and reinforcement still counts it; what changed is that
   * reaching a node is no longer a reason to serve it. This episode shares a session with the
   * one the query is about and nothing else, which is exactly the shape that filled the
   * exercise's off-topic packs to budget: one hit clears the floor and the whole activation
   * spread rides in behind it. It is scored against the query like any other candidate, and
   * what keeps it out is the answer that scoring gives.
   */
  it('refuses an episode the spread reached that measures nothing like the query', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    expect(pack.episodes?.map((item) => item.id)).toEqual([webhooksEpisodeId]);
    // Refused, and said so: a pack this thin has to be readable as a floor doing its job.
    expect(pack.metadata.admission.dropped_below_floor).toBeGreaterThan(0);

    // The claim only means something if no direct leg could have produced it.
    const direct = await vectorSeeds(harness.driver, {
      vector: axis(0),
      limit: 1,
      mode: withCurrency(),
    });
    expect(direct.map((row) => row.id)).toEqual([webhooksEpisodeId]);
    const lexical = await fulltextSeeds(harness.driver, {
      query: CUE,
      limit: 10,
      mode: withCurrency(),
    });
    expect(lexical.map((row) => row.id)).not.toContain(unrelatedEpisodeId);
  });

  it('renders what it served and persists it under the reading session', async () => {
    const started = performance.now();
    const pack = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );
    const elapsed = performance.now() - started;

    expect(pack.rendered_text).toContain('## Episodes');
    expect(pack.rendered_text).toContain(WEBHOOKS_OBSERVATION);
    // The caller's own question leads the cue set, ahead of whatever the model extracted.
    expect(pack.metadata.cues).toEqual([
      { text: QUERY, source: 'query', weight: 3 },
      { text: CUE, source: 'query', weight: 3 },
    ]);
    expect(pack.metadata.token_estimate).toBeGreaterThan(0);
    const timings = pack.metadata.stage_timings_ms;
    for (const stage of ['cues', 'embed', 'seeds', 'activation', 'fusion'] as const) {
      expect(timings[stage]).toBeGreaterThanOrEqual(0);
    }
    // Sequential stages inside one call, so the sum is bounded by the call: against a real
    // server and a real model this is the reading that says the spans are spans.
    const spent = Object.values(timings).reduce((total, ms) => total + ms, 0);
    expect(spent).toBeLessThanOrEqual(elapsed);

    expect(getLastPack(db, READ_SESSION)?.pack).toEqual(pack);
  });

  it('returns an explicitly empty pack when the substrate held nothing yet', async () => {
    const pack = await handleRecall(
      deps,
      { query: QUERY, knew_at: BEFORE_ANYTHING },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    expect(pack.facts).toBeUndefined();
    expect(pack.episodes).toBeUndefined();
    expect(pack.narratives).toBeUndefined();
    expect(pack.preferences).toBeUndefined();
    expect(pack.resonant).toBeUndefined();
    expect(pack.rendered_text).toContain('No memories matched this query.');
    expect(pack.metadata.cues).toHaveLength(2);
  });

  /**
   * The substrate node answers to its own name, so a cue naming it resolves it as a seed. It
   * is connectivity rather than something a person said, and the structural drop is what keeps
   * it out of every bucket.
   */
  it('never serves the substrate node itself, however a cue names it', async () => {
    const namingSubstrate: RecallDeps = {
      ...deps,
      provider: {
        embed: (texts) => provider.embed(texts),
        generate: () =>
          Promise.resolve({ query_cues: [SUBSTRATE_NAME], summary_cues: [], recent_turn_cues: [] }),
      },
      cueCache: new CueCache(),
    };

    const pack = await handleRecall(
      namingSubstrate,
      { query: `what is ${SUBSTRATE_NAME}` },
      { identity: READ_SESSION, now: RECALLED_AT },
    );

    const served = Object.values(packBuckets(pack)).flatMap((items) =>
      items.map((item) => item.id),
    );
    expect(served).not.toContain(substrateId);
    expect(pack.rendered_text).not.toContain(SUBSTRATE_NAME);
  });
});

describe('pending_enrichment metadata', () => {
  const PENDING_SESSION = 'recall-int-pending-session';
  const PENDING_AT = new Date('2026-06-03T09:00:00.000Z');

  /** Settles every stage the policy requires of one source, the way a finished pass leaves it. */
  function settle(sourceId: string): void {
    const generation = readActiveGeneration(db, sourceId)?.processingGeneration ?? 0;
    for (const name of REQUIRED_STAGES) {
      completeSourceWork(
        db,
        stageWorkId(sourceId, generation, name),
        { outcome: 'complete', reason: 'accepted_pass_applied' },
        PENDING_AT,
      );
    }
  }

  it("counts the calling session's own sources that still owe stage work", async () => {
    await push('first pending observation', PENDING_AT, PENDING_SESSION);
    const second = await push('second pending observation', PENDING_AT, PENDING_SESSION);
    await push('third pending observation', PENDING_AT, PENDING_SESSION);

    // Only `second` has its pass accounted for; the orchestrator never runs in this file, so the
    // other two stay open the way a fresh source always does before the worker reaches it. The
    // orchestrator's own ledger key is stamped beside it because a recovery still reads it, but
    // the count is over the work records — the key alone says nothing about what is owed.
    settle(second);
    markLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, second));

    const pack = await handleRecall(
      deps,
      { query: 'pending observation' },
      {
        identity: PENDING_SESSION,
        now: PENDING_AT,
      },
    );

    expect(pack.metadata.pending_enrichment).toBe(2);
  });

  it("omits pending_enrichment once every one of the session's sources is accounted for", async () => {
    const session = 'recall-int-fully-enriched-session';
    const episodeId = await push('a fully enriched observation', PENDING_AT, session);
    settle(episodeId);
    markLedgerApplied(db, orchestratorLedgerKey(PIPELINE_VERSION, episodeId));

    const pack = await handleRecall(
      deps,
      { query: 'fully enriched observation' },
      {
        identity: session,
        now: PENDING_AT,
      },
    );

    expect(pack.metadata.pending_enrichment).toBeUndefined();
  });
});

describe('per-method pack contribution counters', () => {
  it('accumulates across separate recalls rather than resetting on each one', async () => {
    const before = packMethodCounters(db);

    const first = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );
    const second = await handleRecall(
      deps,
      { query: QUERY },
      {
        identity: READ_SESSION,
        now: RECALLED_AT,
      },
    );

    const after = packMethodCounters(db);
    // Only the methods the counter tracks: `graph_traversal` is the fusion leg's name and no
    // item carries it, so it is not a counter row.
    const methods = [...(first.episodes ?? []), ...(second.episodes ?? [])]
      .map((item) => item.rationale.method)
      .filter((method): method is PackMethod =>
        (PACK_METHODS as readonly string[]).includes(method),
      );
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(after[method]).toBeGreaterThan(before[method]);
    }
  });
});
