import { z } from 'zod';

import { positiveInt, proportion } from './knob-types.js';

/**
 * The `reflection` group's own table, split out of `knobs.ts` the same way `maintenance` and
 * `temporal` are: the pipeline's per-stage thresholds are the longest group in the catalog and
 * every measurement that pins one is written down beside it. `knobs.ts` folds this back in as
 * its `reflection` leaf, so the split is invisible to every reader of `KNOBS` or `KNOB_TABLE`.
 *
 * Each stage owns its thresholds and caps as an options type and takes the value as a
 * constructor option, falling back to the leaf here, so a knob and the pipeline that reads it
 * cannot disagree.
 */

export const REFLECTION_KNOBS = {
  // One hang guard on `provider.generate` for every generating stage, not a latency target:
  // reflection is asynchronous and the value that matters is that a model which never answers
  // cannot hold the worker forever. qwen3:8b with thinking on measured 10-44s with occasional
  // non-returns, and the orchestrator imposes no timeout of its own. Five per-stage knobs
  // carried the same 60s and no deployment ever split them, so a stage that needs its own
  // guard takes it as a constructor option instead of a knob nobody sets.
  stageTimeoutMs: ['AION_REFLECTION_STAGE_TIMEOUT_MS', positiveInt, 60_000],
  maxEntities: ['AION_REFLECTION_MAX_ENTITIES', positiveInt, 32],
  // The cosine the name-vector nominator's hits have to clear. A nomination floor, not a
  // decision line: the evidence tiers and the two-pass judge behind it decide, and nothing
  // merges on this number alone. Re-derived 2026-09-02 against snowflake-arctic-embed2 over
  // the 24 committed cascade pairs plus all 276 cross pairs of their names, folded the way
  // `name_vec` folds them: two arbitrary names p50 0.181, p95 0.336, max 0.463; two names for
  // one referent min 0.367, p05 0.488, p50 0.760, max 0.935. The two bands overlap, which is
  // the property the cascade is built around, so the floor sits above the noise and the
  // overlap goes to the evidence tiers. 0.53 clears the whole 276-pair background by 0.067 and
  // the committed guard pair of unrelated personal names (0.474) by 0.056, and sits 0.057
  // under the weakest duplicate the vector leg is asked to find (0.587, `arctic2` against
  // `snowflake-arctic-embed2`), so it nominates 11 of the 12 duplicate pairs. The one it
  // misses is `GDS` against `Graph Data Science` at 0.367, under the background ceiling: an
  // acronym and its expansion share no characters, and the shared-episode nominator is what
  // reaches that pair. The nomic-era value was 0.85 against a band whose duplicates started at
  // 0.92. `ollama-provider.int.test.ts` holds the guard pairs either side of it.
  entityDedupThreshold: ['AION_REFLECTION_ENTITY_DEDUP_THRESHOLD', proportion, 0.53],
  // The floor the bulk nominator's shared-episode Jaccard has to clear. A nomination floor,
  // not a decision line: everything above it is handed to the evidence tiers, and nothing
  // above it merges on this number alone. A tenth means the two were seen together in about
  // one episode in ten of the history they have between them, which is enough co-occurrence
  // to be worth reading and low enough that a rare name paired with a common one still gets
  // looked at. Sized against the community-size distribution of a live graph; this
  // default is the starting point, not a measurement.
  entityNominationJaccardFloor: [
    'AION_REFLECTION_ENTITY_NOMINATION_JACCARD_FLOOR',
    proportion,
    0.1,
  ],
  // What the cascade's judge tier does with a pair both passes call one thing. `unanimous`
  // merges it; `propose` queues it and merges nothing, which makes it the kill switch. Tier 0
  // reads neither value: a squash-equality merge asks no model, so there is no judgment for a
  // mode over judgments to gate.
  // Set by measurement rather than by hand, on the pre-registered rule the battery prints:
  // auto-merge precision at or above 0.9 over the 24-pair cascade battery ships `unanimous`,
  // anything less ships `propose`, and `entity-cascade-precision.int.test.ts` asserts the
  // shipped value still matches what it measures, in both directions.
  // Measured 2026-09-01 against claude-haiku-4-5 with snowflake-arctic-embed2 embeddings,
  // 24 pairs built into a real graph: TP 8, FP 0, FN 4, TN 12, precision 1.000, recall 0.667.
  // Three merges came from tier 0, five from the judge, and four pairs went to the residue
  // lane. Every miss was a pair the second pass split rather than a wrong merge, which is the
  // shape the bar was written for. Precision held at 1.000 across three runs; recall moved
  // between 0.583 and 0.667 and gates nothing. The cross-type same-referent class is where
  // it is spent: a company and the product named after it reach the second pass, and the
  // second pass separates them.
  entityMergeMode: ['AION_ENTITY_MERGE_MODE', z.enum(['propose', 'unanimous']), 'unanimous'],
  // The cosine two entity content vectors have to reach before a SIMILAR edge is written
  // between them. Re-derived 2026-09-02 against snowflake-arctic-embed2 on entity text spelled
  // the way `entityContentText` spells it: two descriptions of one referent (the 12 duplicate
  // cascade pairs) min 0.543, p05 0.575, p50 0.715, max 0.852; entities that share nothing
  // (all 276 cross pairs of the same descriptions) p50 0.204, p95 0.342, max 0.506; entities
  // co-mentioned in one episode and distinct (10 pairs of the facts battery's glosses) p50
  // 0.268, max 0.410. 0.53 sits above every one of the 286 noise readings and under every
  // same-referent reading, so it writes 12 of 12 and 0 of 286. The valley is 0.037 wide, so
  // the margins are 0.024 above the noise and 0.013 under the weakest genuine pair, and the
  // noise side gets the wider one because an edge written here has no judge behind it. The
  // nomic-era value was 0.75, measured admitting nearly every nearest neighbour.
  associationSemanticThreshold: ['AION_ASSOC_SEMANTIC_THRESHOLD', proportion, 0.53],
  associationSimilarLimit: ['AION_REFLECTION_ASSOCIATION_SIMILAR_LIMIT', positiveInt, 5],
  maxCognitiveNodes: ['AION_REFLECTION_MAX_COGNITIVE_NODES', positiveInt, 20],
  maxRelationships: ['AION_REFLECTION_MAX_RELATIONSHIPS', positiveInt, 40],
  // `propose` writes every detection to `supersession_proposals` and closes nothing, which
  // makes it the kill switch. `unanimous` sends every affirmative judgment to a second model
  // call that argues the other side on the same evidence, and closes only what both passes
  // affirm. `auto` is the confidence gate both predate, still valid and superseded by
  // `unanimous`: the judge answers 0.95 to every affirmative, so its threshold is a
  // pass-through or a wall and never a discriminator.
  // The default is set by measurement rather than by hand. The rule was pre-registered:
  // two-pass precision at or above 0.9 and recall at or above 0.9 on the 24-case battery
  // ships `unanimous`, anything less ships `propose`, and `supersession-precision.int.test.ts`
  // asserts the shipped value still matches what it measures, in both directions.
  // Measured 2026-08-30 against claude-haiku-4-5, 24 pairs: two-pass TP 12, FP 0, FN 0,
  // TN 12, precision 1.000, recall 1.000. The second pass saw 14 affirmatives and vetoed 2,
  // both on survival, both the false positives the single pass emitted (precision 0.857 on
  // the same run). The reviewer's prompt was written against those two shapes before the
  // measurement, which is a real risk of fitting the instrument: the number to watch is
  // whether it holds on pairs this set does not contain.
  supersedeMode: ['AION_SUPERSEDE_MODE', z.enum(['propose', 'auto', 'unanimous']), 'unanimous'],
  // The subject-keyed closure path's own switch, independent of `supersedeMode`: it runs
  // inside a different stage's write and needs to be killable on its own. `off` is the kill
  // switch and skips the keyed lookup entirely. `judge` routes a keyed candidate into the
  // same two-pass unanimous supersession judge `supersedeMode` uses, which closes it
  // autonomously. `close` is the mechanical keyed close, made in the writing transaction.
  // The default is set by measurement rather than by hand, on a rule pre-registered before
  // the numbers: precision at or above 0.95 over the 24-case keyed-close battery, made on at
  // least four mechanical closes, ships `close`; short of either it ships `judge`, and
  // `keyed-close-precision.int.test.ts` asserts the shipped value against what it measures,
  // in both directions. The bar is above the 0.9 the two judge batteries carry because this
  // is the one closure path with no second opinion behind it.
  // Measured 2026-09-01 against claude-haiku-4-5 with snowflake-arctic-embed2 embeddings, 24
  // pairs of sessions run through the shipped extraction stages: 2 closes, TP 2, FP 0, FN 6,
  // precision 1.000, recall 0.250. Both trap classes held, 6 of 6 and 6 of 6, and all four
  // sessions stating no single attribute kept every key off. What ships `judge` is the sample
  // and not the precision: 16 claims carried a key at all, 3 of the 24 cases carried one on
  // both halves, and the mechanism was therefore asked twice. The aspect slug is where the
  // recall goes. One case keyed the same entity from both sides and still missed, on
  // "checkpoint state storage location" against "checkpoint state storage backend"; every
  // other miss never keyed the earlier half at all. That is the number to move before this
  // is measured again.
  keyedCloseMode: ['AION_KEYED_CLOSE_MODE', z.enum(['off', 'judge', 'close']), 'judge'],
  /** The `auto` path's threshold only. No other mode reads it. */
  supersedeAutoConfidence: ['AION_SUPERSEDE_AUTO_CONFIDENCE', proportion, 0.85],
  // The cosine a neighbor must clear to reach the contradiction judge on the vector leg. Not
  // re-derived against snowflake-arctic-embed2. The population it gates measures min 0.408,
  // p50 0.814, max 0.932 (the 24 supersession battery pairs), so about half of them fall under
  // 0.75 and reach the judge on the subject-family leg alone.
  supersedeNeighborThreshold: ['AION_REFLECTION_SUPERSEDE_NEIGHBOR_THRESHOLD', proportion, 0.75],
  // How close a sibling claim has to be to the judged one before a family apply closes it too.
  // Two claims from one observation can name the same subject and be about different things;
  // this is where that line sits. Under the neighbour threshold, because these two already
  // share an observation and a named subject: the evidence a family close needs on top of that
  // is that they are about the same thing, not that they nearly restate each other.
  // Re-measured 2026-09-02 against snowflake-arctic-embed2 and left where it was, which is the
  // one number in this pass that the new space did not move. The granularity gate's own two
  // claims are the band: the sibling that says what the corrected subject does reads 0.537
  // against the judged claim and has to hold, and the sibling that asserts the same attribute
  // reads 0.841 and has to close, so 0.6 sits 0.063 above the hold and 0.241 under the close.
  // The same two pairs read 0.732 and 0.868 under nomic-embed-text, where this floor was set:
  // that model put the sibling a correction does not touch above the floor, so it closed, and
  // arctic2 is what separates the two questions rather than compressing them together.
  // Wider fixture pairs, same shape: siblings asserting one attribute of one subject 0.826 to
  // 0.850, siblings asserting another attribute of it 0.323 to 0.766, with two-environment
  // counts (0.865) the standing overlap no floor resolves.
  supersedeFamilyRelatednessFloor: [
    'AION_REFLECTION_SUPERSEDE_FAMILY_RELATEDNESS_FLOOR',
    proportion,
    0.6,
  ],
  maxSupersessionSubjects: ['AION_REFLECTION_MAX_SUPERSESSION_SUBJECTS', positiveInt, 6],
  maxContradictionNeighbors: ['AION_REFLECTION_MAX_CONTRADICTION_NEIGHBORS', positiveInt, 3],
  maxContradictionJudgments: ['AION_REFLECTION_MAX_CONTRADICTION_JUDGMENTS', positiveInt, 8],
  /** Minutes, because that is the unit the pinned trigger is stated in (30 min idle). */
  narrativeIdleMinutes: ['AION_REFLECTION_NARRATIVE_IDLE_MINUTES', positiveInt, 30],
  // The mid-session boundary: a running session is compressed before anyone closes it, so what
  // recall reaches mid-flight is a narrative rather than raw episodes. Off, the close and the
  // idle window are the only boundaries, which is the behaviour that came before it.
  midSessionRollup: ['AION_REFLECTION_MID_SESSION_ROLLUP', z.boolean(), true],
  // Uncovered episodes that make a running session worth compressing. Twelve is under a third
  // of the source ceiling a narrative renders, so a session crossing it has enough behind it to
  // compress and enough ahead of it that the close still has something to add.
  midSessionEpisodes: ['AION_REFLECTION_MID_SESSION_EPISODES', positiveInt, 12],
  // Silence that reads as one stretch of work finishing. A third of the idle window: shorter
  // than the silence that ends a session, longer than a pause for a build.
  midSessionGapMinutes: ['AION_REFLECTION_MID_SESSION_GAP_MINUTES', positiveInt, 10],
  maxNarrativeEpisodes: ['AION_REFLECTION_MAX_NARRATIVE_EPISODES', positiveInt, 40],
  maxNarrativeEpisodeChars: ['AION_REFLECTION_MAX_NARRATIVE_EPISODE_CHARS', positiveInt, 2_000],
  // The three above are what qwen3:8b was measured on, and these three are what the same
  // synthesis reads and writes when generation routes to Haiku. Inert on the local route:
  // `narrativeScale` reads one set or the other off the resolved route, so a substrate with no
  // key never sees these values whatever they are set to. Three times the episodes and twice
  // the sentences, sized to the model rather than measured: Haiku takes a 120-episode session
  // in one call and answers at twelve sentences without strain, where the local model starts
  // repeating itself. The character cap doubles with them, because a wider window that clips
  // each episode harder trades one loss for another.
  keyedNarrativeEpisodes: ['AION_KEYED_NARRATIVE_EPISODES', positiveInt, 120],
  keyedNarrativeSentences: ['AION_KEYED_NARRATIVE_SENTENCES', positiveInt, 12],
  keyedNarrativeEpisodeChars: ['AION_KEYED_NARRATIVE_EPISODE_CHARS', positiveInt, 4_000],
  narrativeSweepLimit: ['AION_REFLECTION_NARRATIVE_SWEEP_LIMIT', positiveInt, 20],
} as const;
