# Architecture

## Packages and dependency direction

`protocol` is the leaf: Zod schemas for the two tool contracts (`recall-input`,
`recall-output`, `reflection-input`, `reflection-output`) plus shared types
(`IsoTimestampSchema`, `CurrencySchema`, `SupersededBySchema`). It imports nothing from
the rest of the workspace.

`core` depends on `protocol` for wire schemas and nothing else in the workspace. `mcp` and
`cli` both depend on `core` (and transitively on `protocol`); neither depends on the other.

## Bounded contexts inside core

Each context that has both pure logic and orchestration splits into `domain/` (no I/O, no
config, no logger) and `application/` (everything that touches the graph, SQLite, or a
model). The layering rule holds everywhere: `domain/` never imports `application/`;
`application/` imports `domain/` and `infrastructure/`; `infrastructure/` imports nothing
from `recall/`, `reflection/`, `session/`, or `redaction/`. It has no notion of episodes,
cues, or memory packs, only nodes, edges, and rows.

- **`infrastructure/`**: `graph/` (every Cypher statement in the workspace), `sqlite/`
  (the reflection queue, last-pack cache, ops ledger, claim locking), `providers/` (the
  Ollama and Anthropic clients, the circuit breaker, the per-role routing layer and the
  model reconciliation that follows it), `config/` (schema, defaults, the `AION_*`
  registry, the loader), `logging/`.
- **`recall/domain/`**: `activation.ts` (spreading activation over adjacency),
  `activation-weights.ts` (the per-relationship-type propagation table),
  `admission.ts` (the evidence rules and the floors), `arrival-scoring.ts` (cosines for what
  the spread reached), `seed-selection.ts` (the budget curve and the per-leg reservations),
  `fusion.ts` (RRF/MMR ranking and the currency policy), `resonance.ts` (the centroid and the
  shape of a resonant item), `pack.ts` (MemoryPack assembly).
- **`recall/application/`**: `cues.ts` (cue extraction and its cache), `seeds.ts` (the
  four seed strategies' scoring and merge), `candidates.ts` (seeds plus activation into
  ranked lists), `stage-reads.ts` (the pipeline's batched graph reads), `resonance.ts` (the
  second pass), `recall.ts` (the pipeline), `side-effects.ts` (post-recall listeners).
- **`plasticity/`**: `domain/` folds a window of co-activation signals into per-pair
  learning rates and computes the staleness curve; `application/` runs the two operations
  that apply them, `flush.ts` (bounded reinforcement of the nominated pairs) and `decay.ts`
  (weight decay against staleness, the protected relationship types exempt), plus
  `metrics.ts`. Both operations are called, never scheduled: cadence belongs to the caller.
- **`introspection/domain/`**: `health.ts` (the snapshot every phase reads), `decide.ts`
  (the pure three-tier decision, starvation protection, effectiveness weighting),
  `operation.ts` (the contract a maintenance operation implements), `buckets.ts`
  (calendar-aligned idempotency keys), `tier3.ts` (the model-guided seam, opt-in and
  propose-only).
- **`introspection/application/`**: `observe.ts` (one health reading, assembled from the
  surfaces `doctor` and `/health` already use, every collector caught), `engine.ts` (the
  tick loop: bucket claim, run, learn, backoff), `catalog.ts` (the registration seam),
  `plasticity-operations.ts` (the flush and the decay sweep, adapted to the contract).
- **`reflection/domain/`**: `content.ts`, episode/turn shaping and content hashing.
- **`reflection/application/`**: `intake.ts` (the write path), `dispatch.ts` (the event
  emitter intake signals), `worker.ts` (the subscriber: claims queue rows and runs the
  orchestrator), `orchestrator.ts` and `stages/` (the enrichment pipeline),
  `narratives.ts`, `lanes.ts`, `vectors.ts` (pending-vector backfill).
- **`redaction/`**: `entropy.ts`, `rules.ts`, `deep-walk.ts`, `redact.ts`,
  `fingerprint.ts`. Deterministic and rule-based by design: this is the one place inference
  is deliberately not used, because a credential leak cannot wait on a model's judgment.
- **`session/`**: `session-manager.ts`, identity-to-session-id resolution, cached per
  process, backed by `infrastructure/graph/sessions.ts`.

One edge crosses contexts: `recall/domain/fusion.ts` imports `hashContent` from
`reflection/domain/content.ts` to dedupe fused items by content hash before packaging,
the same hash reflection uses as its episode dedupe key. It is the sole domain-to-domain
import in the codebase.

## Write path: reflection intake

`handleReflection` (`reflection/application/intake.ts`) runs these steps in order:

1. Parse the payload against `ReflectionInputSchema`; reject anything that fails.
2. Split off `session_id`. It is routing, not content, so it never reaches the hash or
   the redaction walk.
3. Redact the remaining payload (`redactPayload`): every string field in `turns`,
   `tool_executions`, and `observations` is walked and scanned against the rule set and an
   entropy threshold; matches are stripped and logged, never stored.
4. Resolve the session (`ensureSession`), reusing a cached identity-to-session-id mapping
   when one exists.
5. Shape the payload into one episode and its turns (`prepareEpisode`), each carrying a
   sha256 content hash over a canonically key-sorted JSON encoding.
6. Check for a duplicate by `(sessionId, contentHash)` outside any transaction. If found,
   skip straight to step 8: no write, no new queue row.
7. Otherwise open a single write transaction and commit the durable record first: lock the
   session node (which serializes intake for that session and closes the race where two
   concurrent identical payloads both miss the duplicate check), re-check the duplicate
   under the lock, write the stamped `Episode` node and each stamped `Turn` node with no
   vector properties, and link `Turn -[:PARTICIPATES_IN]-> Episode`,
   `Episode -[:PARTICIPATES_IN]-> Session`, and `Turn -[:FOLLOWS]-> <previous Turn>`.
8. Find or create a pending `integrate` job in the SQLite reflection queue, keyed by
   episode id and carrying its lane. The check is against the queue, not assumed from step
   7's outcome, so a crash between the episode commit and the enqueue self-heals on the
   next identical push.
9. If a new job was enqueued, signal `ReflectionDispatch` so a subscribed worker can start
   immediately; the SQLite row is what a restart replays from regardless.
10. Return `{ episode_id, queued: true }` plus the assigned `lane` and `pending_ahead`
    (unclaimed interactive jobs ahead at enqueue time).
11. Embed the episode text and every turn's text in one batched Ollama call and attach the
    content vectors in a follow-up write. A failure here changes nothing above: the
    episode, its turns, and the queue row are already committed, and a `:Memory` node
    without its `content_vec` property is the pending marker the worker's startup drain
    and the `vector_backfill` path complete when Ollama returns.

A Neo4j outage in step 7 still refuses honestly with `ReflectionNotStoredError`: nothing is
half-written, and the message says the experience was not kept. An Ollama outage no longer
loses anything: the record commits, the job queues, and the vectors arrive when the model
does. `docs/degradation.md` holds the live-verified behavior for both modes.

No generation call happens after step 7. Extraction, turning an episode into entities,
associations, cognitive structure and narratives, is a separate pipeline that subscribes to
the dispatch signal. `ReflectionWorker` claims the queue row the signal announces and runs
`ReflectionOrchestrator` over the stage list `packages/mcp/src/bootstrap.ts` registers. The
queue row is the durable truth; the signal is best-effort.

Which row it claims is a scheduling decision, not insertion order. Every row carries a lane
(`interactive` by default, `bulk` when the caller flagged it or the arrival-rate backstop
demoted the session), the session it belongs to, and its turn within that (lane, session)
group. `claimNext` orders by lane first, then turn, then insertion, so the bulk lane never
runs while an interactive job is claimable, and inside a lane the sessions interleave. The
turn is stamped at enqueue rather than computed at claim time: a window function over the
unclaimed rows renumbers every group as rows leave it, which collapses the interleave back
into first-in-first-out after the first claim.

## Read path: recall

`handleRecall` (`recall/application/recall.ts`) runs these stages, each timed
independently for the pack's `stage_timings_ms`:

1. **Cues.** One generation call (the cue model) turns the query, and optionally a summary
   and recent turns, into weighted cues: query text weighs 3x, summary 2x, recent-turn
   text 1x. If the call times out, errors, or returns something unparseable, recall falls
   back to a raw-query/raw-summary cue instead of failing, and the pack records that
   degradation. `AION_CUE_BUDGET_MS` guards the call at 8000ms, a deliberate deviation from
   PRD §14's 2000: the pinned cue model answers in 558-811ms warm and a measured 2030ms on
   the run after an eviction, so the pinned value fires on ordinary recalls.
2. **Embed.** Every cue is embedded in one batched call. A failure here costs recall its
   vector leg only; BM25 and exact entity resolution still run on cue text. The pack records
   that rung too, so a full Ollama outage (cues and embeddings both gone) is legible as more
   than a cue-model failure.
3. **Seeds.** Four strategies run together: `vector` (nearest neighbors in the two content
   vector indexes), `bm25` (the fulltext index), `entity_resolution` (exact and
   fuzzy name match against `Entity` nodes), and `recency` (a `tx_from`-ordered fallback
   for a substrate with no access history yet). Candidates merge by node id; a node found
   by more than one strategy keeps every strategy that found it. A rejected query costs its
   own leg and nothing else, but the rejections are counted: when every query issued was
   rejected the graph is gone, and the pack says so (`degraded: [{stage: graph, reason:
   unavailable}]`) instead of reporting an outage as an empty substrate. The budget scales
   with the substrate (`base + growth * ln(population)`, capped by
   `AION_CONTEXT_RESONANCE_SEED_LIMIT`) and reserves a share of it per leg, so a graph of a
   few thousand memories still measures candidates a fixed ten-seed budget never saw.
4. **Activation.** Every seed enters at full activation. Spreading runs in TypeScript over
   batched adjacency reads: the graph answers one question per frontier iteration, and
   everything else (per-relationship-type weighting, decay, the minimum-activation floor,
   the max-nodes-visited cap) happens in process, where it is unit-testable without a
   server.
5. **Fusion.** Seed and activated candidates are hydrated, then fused: weighted Reciprocal
   Rank Fusion across the vector/bm25/graph_traversal legs by default (`rrf`, k=60), or
   MMR reranking when `AION_SEARCH_RERANKER=mmr`. Ranking and admission are separate:
   an item reaches the pack only on absolute evidence: a cosine at or above
   `AION_VECTOR_ADMISSION_FLOOR`, a Lucene match on the verbatim cue, two independent
   measurements at or above `AION_CORROBORATION_FLOOR`, or traversal from a pack something
   else anchored, however well it ranks. Duplicates collapse by content hash, keeping the
   higher-ranked instance. An item the spread reached and no strategy seeded is scored
   against the query cues on its own content vector, so traversal supplies candidates and
   never admission.
6. **Context resonance.** A second pass, after fusion because it needs to know the first one
   anchored: the activation-weighted mean of the activated set's context vectors becomes a
   query against the context vector index, above
   `AION_CONTEXT_RESONANCE_CONTEXT_SEARCH_THRESHOLD` and excluding every id the first pass
   already produced. What comes back is related by the shape of its neighborhood rather than
   by its words, so it lands in `resonant` under its own rationale and never competes with a
   fused score. The stage is skippable (`AION_RECALL_USE_CONTEXT_RESONANCE`), timed like
   every other stage, and declines to run at all on a query nothing anchored: resonating from
   an unanchored pack searches the shape of nothing.
7. **Pack assembly.** Fused items route to a bucket by node label: `Episode`/`Turn` to
   `episodes`, `Entity` to `facts`. Each bucket is capped, trimmed to the token budget,
   and rendered into the pack's text block. The episode cap (`AION_RECALL_MAX_EPISODES`)
   defaults to 20, a deliberate deviation from whitepaper Appendix E's 5: the cap cuts the
   fused list, so on a populated substrate a five-item cut is filled by near-tie vector hits
   before any traversal-reached item can land. The token budget is what actually bounds a
   pack's size. `preferences` has no producer yet, so it is structurally absent rather than
   empty. `narratives` gained one in P3: a session's close, or the idle sweep, compresses its
   episodes into a `Narrative` node. `resonant` gained one in P4: the second pass above.

Both paths inherit the driver timeouts `GraphConnection` sets: 5s to connect, 10s to acquire
a pooled connection, 10s of transaction retries. The driver's defaults (60s and 30s) meet or
exceed the MCP client's 60s request timeout, which is how a call against a stopped Neo4j
reached the caller as a client-side timeout with the server's own error lost. A healthy pool
answers in microseconds, so these bite only during an outage. See `docs/degradation.md` for
every failure mode this pipeline degrades through, mode by mode, with live evidence.

The pack is saved to SQLite's `last_pack` table (what `aion last` renders) and returned. A
registered listener fires afterward and is never awaited, so a listener failure cannot fail a
recall that already succeeded: it stamps access metadata and nominates the co-activated pairs
that the reinforcement flush later folds into edge weights. A time-travel read does neither,
since asking what the substrate held last month is a question rather than a use.

## Bitemporal model

Every node carries three time concepts, all set at write time and never rewritten except
by `supersede`:

- **`occurred_at`**: when the experience happened. Defaults to the write-time clock;
  callers may backdate individual turns.
- **`valid_from` / `valid_until`**: world time, the interval during which the fact was
  true. `valid_until` absent means still current.
- **`tx_from` / `tx_until`**: system time, the interval during which the substrate held
  this belief. `tx_until` absent means still held.
- **`forgotten_at`**: the one true suppression, written by the not-yet-built `aion
  forget`. Default recall hides a forgotten row; `as_of`/`knew_at` still surface it.

`supersede(driver, { oldId, newId })` closes both intervals on the old node with a
`coalesce` (so a repeated call is a no-op) and links
`(new)-[:SUPERSEDES]->(old)` in the same transaction. A closed node with no lineage edge
is not a state the substrate can reach.

`supersedeEpisode(driver, { oldId, newId })` is the Episode form
(`infrastructure/graph/episode-supersession.ts`). It does the same close, then in the same
transaction closes every node whose only open `EXTRACTED_FROM` source was that episode and
links each to the new episode with provenance `supersession_episode_propagation`. Closing an
episode alone leaves its facts open, and recall then serves the corrected value as `current`.
`propagateEpisodeSupersession` runs the second half over an episode something else already
closed.

Four read modes, all built from one composable fragment
(`infrastructure/graph/read-modes.ts`) so every seed strategy and the traversal share one
definition of currency:

- **`withCurrency()`**: the default. No time is pinned; a row is included whenever
  `forgotten_at IS NULL`. Every returned item still carries a `currency` label (`current`
  or `superseded`, judged against now) and, when superseded, a `superseded_by { id, at }`
  pointer. This is currency-aware, not currency-filtered: superseded knowledge is still
  eligible, just annotated.
- **`asOf(validAt)`**: a world-time slice, rows whose valid interval covers `validAt`.
- **`knewAt(knownAt)`**: a system-time slice, rows whose transaction interval covers
  `knownAt`. Lineage itself is filtered to supersessions recorded by `knownAt`, so a
  knowledge-time read cannot report a correction the substrate had not made yet.
- **`bitemporalAt(validAt, knownAt)`**: both predicates at once, what the substrate
  believed at `knownAt` about what was true at `validAt`.

One write is exempt from strict idempotency by design: `access-tracking.ts` bumps
`last_accessed` and increments `access_count` on every node a recall surfaces, and running
it twice for the same node doubles the count on purpose, because it is a real access, not
a retry, and should double it. Retried or duplicated *content* writes (episodes, turns,
edges) are unaffected; that guarantee holds through `MERGE`.

## Graph schema surface

**Node labels.** `Session`, `Episode`, `Turn`, `Entity`, `Member`, `Workspace` are the
primary labels. Every node also carries `AionNode`, which is what gives type-agnostic id
lookups (both edge endpoints, the supersession close) an index to seek. Neo4j has no
label-free property index, so without it those lookups would scan the whole graph.
Content-bearing nodes (`Episode`, `Turn`) additionally carry `Memory`, because a Neo4j
vector index cannot span a label union: `Memory` is the only mechanism that lets one
vector index cover more than one node type. The backbone nodes (`Member`, `Workspace`)
additionally carry `Entity`, so the composite `(name_norm, type)` uniqueness constraint
and the entity-resolution seed strategy both apply to them.

**Indexes and constraints** (migration 001, `infrastructure/graph/migrations.ts`):

- Uniqueness constraints on `AionNode.id`, and on `.id` for `Session`, `Episode`, `Turn`,
  `Member`, `Workspace`; a composite constraint on `Entity(name_norm, type)`.
- Two vector indexes, `content_vec_idx` and `context_vec_idx`, both `FOR (n:Memory)`, both
  cosine similarity at the configured embed dimension (768 by default, `nomic-embed-text`).
- Two range indexes, `memory_valid_until_idx` and `memory_tx_until_idx`, both
  `FOR (n:Memory)`. They serve the bounded half of a time-travel filter
  (`valid_until > t`); the open-interval half (`IS NULL`) has no index to seek and is a
  scan by construction.
- One fulltext index, `memory_content_fts`, over `Episode|Turn|Entity` plus every P3
  cognitive label and `Narrative`, `ON [summary, text, name]`, the target of the `bm25` seed
  strategy. It replaced migration 001's narrower `content_fts` under a new name rather than
  by a drop-and-recreate: `runGraphMigrations` replays every statement on every `aion init`,
  so a rename is what keeps a re-init from destroying and repopulating a healthy index.

**Edge merge policy** (`infrastructure/graph/edges.ts`). Every relationship write goes
through one `MERGE`, matched on endpoint ids resolved through `AionNode`: on create it
sets strength, confidence, signal and provenance lists, and a count; on match it takes
`max(strength)`, `max(confidence)`, set-union on signals, set-union on provenance,
`sum(count)`, and refreshes `updated_at` while leaving `created_at` alone. Undirected
relationship types (`SIMILAR`, `CO_OCCURS`, `RELATED_TO`, `ANALOGOUS_TO`) normalize their
endpoint order before the merge, so writing an edge from node A to node B and later from B
to A lands on one edge, not two. Twenty-two directed types cover containment
(`PARTICIPATES_IN`), temporal chaining (`FOLLOWS`, `PRECEDES`), provenance
(`DERIVES_FROM`, `EVIDENCES`, `EXTRACTED_FROM`), the backbone (`HAS_MEMBER`,
`HAS_WORKSPACE`), and this build's bitemporal extension, `SUPERSEDES`.
