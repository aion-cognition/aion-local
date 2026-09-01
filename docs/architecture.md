# Architecture

How this repo is put together: packages, the read and write paths, the maintenance loop, and
the graph schema. For what the system is and why it is built this way, see
[whitepaper.md](whitepaper.md), which also owns the list of places this build departs
from the design it came from.

## Packages and dependency direction

`protocol` is the leaf: Zod schemas for the two tool contracts (`recall-input`,
`recall-output`, `reflection-input`, `reflection-output`) plus shared types
(`IsoTimestampSchema`, `CurrencySchema`, `SupersededBySchema`). It imports nothing from
the rest of the workspace.

`core` depends on `protocol` for wire schemas and nothing else in the workspace. `mcp` and
`cli` both depend on `core` (and transitively on `protocol`). The dependency between the
top two runs one way: `cli` imports a few operational constants from `mcp` (the health
path, the container check, the usage protocol), and `mcp` imports nothing from `cli`.

## Bounded contexts inside core

Each context that has both pure logic and orchestration splits into `domain/` and
`application/` (everything that touches the graph, SQLite, or a model). `domain/` is not free
of infrastructure: twenty-one of its modules import from `infrastructure/`, most for type-only DI
contracts (`Config`, `Logger`, `Driver`, `SqliteHandle`, `Provider`, the shape `operation.ts`
and `stage.ts` declare for what a stage or operation receives). Two cross into value coupling:
`introspection/domain/proposal-hygiene.ts` imports the `DEFAULTS` config object and reads two
of its fields as fallback horizons, and `introspection/domain/tier3.ts`'s `proposeOnlyAdvisor`
takes a `Logger` and calls `logger.info`, I/O executed from inside domain code rather than
merely typed against it. What still holds: `domain/` never imports `application/`;
`application/` imports `domain/` and `infrastructure/`; `infrastructure/` imports nothing from
the six contexts above it, and has no notion of episodes, cues, or memory packs, only nodes,
edges, and rows.

- **`infrastructure/`**: `graph/` (every Cypher statement in the workspace), `sqlite/`
  (the reflection queue, last-pack cache, the served-item record, ops ledger, claim locking,
  and the two proposal
  queues, whose reads share one `proposal-table.ts` because both are an id, the pair the
  proposal is about, and a `resolved_at` that is null while a person still owes the row a
  decision), `providers/` (the Ollama and Anthropic clients, the circuit breaker, the
  per-role routing layer and the model reconciliation that follows it), `config/` (schema,
  defaults, the `AION_*` registry, the loader), `logging/`.
- **`recall/domain/`**: `activation.ts` (spreading activation over adjacency),
  `activation-weights.ts` (the per-relationship-type propagation table),
  `admission.ts` (the evidence rules and the floors), `arrival-scoring.ts` (cosines for what
  the spread reached), `seed-selection.ts` (the budget curve and the per-leg reservations),
  `fusion.ts` (weighted RRF, the admission decision, and the currency policy), `ranking.ts`
  (the ordering machinery fusion hands its admitted list to: MMR, the near-duplicate cluster
  cap, cosine), `facts.ts` (the restatement floor and the gloss cap), `resonance.ts` (the
  centroid and the shape of a resonant item), `pack-buckets.ts` (which bucket a node label
  answers in), `pack.ts` (MemoryPack assembly).
- **`recall/application/`**: `cues.ts` (cue extraction and its cache), `seeds.ts` (the
  four seed strategies' scoring and merge), `candidates.ts` (seeds plus activation into
  ranked lists), `stage-reads.ts` (the pipeline's batched graph reads), `resonance.ts` (the
  second pass), `recall.ts` (the pipeline), `side-effects.ts` (post-recall listeners).
- **`plasticity/`**: `domain/` folds a window of co-activation signals into per-pair
  learning rates and computes the staleness curve; `application/` runs the two operations
  that apply them, `flush.ts` (bounded reinforcement of the nominated pairs) and `decay.ts`
  (weight decay against staleness, the protected relationship types exempt), plus
  `metrics.ts`. Both operations are called, never scheduled: cadence belongs to the caller.
- **`introspection/domain/`**: `health.ts` (the snapshot every phase reads, plus the critical
  conditions read off it), `decide.ts` (the pure three-tier decision, starvation protection,
  effectiveness weighting, the preemption grace), `operation.ts` (the contract a maintenance
  operation implements), `bridge-pairs.ts` (which two communities a bridge should join),
  `buckets.ts` (calendar-aligned idempotency keys), `tier3.ts` (the model-guided seam, opt-in
  and propose-only).
- **`introspection/application/`**: `observe.ts` (one health reading, assembled from the
  surfaces `doctor` and `/health` already use, every collector caught), `engine.ts` (the
  tick loop: bucket claim, run, learn, backoff), `catalog.ts` (the registration seam),
  `plasticity-operations.ts` (the flush and the decay sweep, adapted to the contract), and
  `operations/`, one file per registered operation plus `unmerge.ts`, the repair the loop
  never selects on its own.
- **`reflection/domain/`**: `content.ts` (episode/turn shaping and content hashing),
  `stage.ts` (the contract every stage implements and how the orchestrator records it),
  `entity-extraction.ts`, `entity-identity.ts` and `entity-merge.ts` (name folding, the
  name-form half of identity, and the grouping a dedup run reduces to),
  `associations.ts` (pair combinatorics), `context-vector.ts` (the strength-weighted mean),
  `narrative.ts` (the session boundary and versioning rules).
- **`reflection/application/`**: `intake.ts` (the write path), `worker.ts` (claims queue
  rows and runs the orchestrator), `orchestrator.ts` and `stages/` (the enrichment
  pipeline), `narratives.ts`, `lanes.ts`, `vectors.ts` (pending-vector backfill),
  `reconcile.ts`, `lag.ts`, `proposals.ts`.
- **`redaction/`**: `entropy.ts`, `rules.ts`, `deep-walk.ts`, `redact.ts`,
  `fingerprint.ts`, `residue.ts`. Deterministic and rule-based by design: this is the one
  place inference is deliberately not used, because a credential leak cannot wait on a
  model's judgment.
- **`session/`**: `session-manager.ts`, identity-to-session-id resolution, cached per
  process, backed by `infrastructure/graph/sessions.ts`.

Cross-context imports are not one edge; eight directed pairs exist, about thirty imports
total. `introspection/` is the heaviest importer: twelve from `reflection/` (queue lag,
reconciliation, vector backfill, narrative cleanup, and the entity-merge and dedup machinery
`merge_auto` and `retro_judgment_sweep` read directly, reached from both `domain/` and
`application/`), four from `redaction/`, three from `plasticity/`. `recall/domain/` still
imports from `reflection/domain/`, in five files now rather than four: `fusion.ts`, `pack.ts`,
`ranking.ts` and `session-dedup.ts` take `hashContent` from `content.ts`, and `resonance.ts`
takes `weightedMeanVector` from `context-vector.ts`; `recall/application/stage-reads.ts` adds
a sixth import, of `orchestratorLedgerKey` from `reflection/application/orchestrator.ts`.
`recall/` also imports once from `session/`, and `reflection/` imports once from
`plasticity/`, twice from `redaction/`, and once from `session/`. Nothing crosses back into
`recall/domain/`, and `infrastructure/` still imports from none of the six.

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
9. If a new job was enqueued, call the `onJobEnqueued` callback so the worker can start
   immediately. The service wires that callback to `worker.wake()`; the SQLite row is what a
   restart replays from regardless. A callback that throws is logged and swallowed, since by
   then the episode is in the graph and the job is in the queue.
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
associations, cognitive structure and narratives, is a separate pipeline. `ReflectionWorker`
runs its own claim loop and `wake()` pumps it; the wakeup carries no job, so a wakeup for a
row another worker already took costs one empty claim attempt and nothing else. The worker
then runs `ReflectionOrchestrator` over the stage list `packages/mcp/src/bootstrap.ts`
registers. The queue row is the durable truth; the wakeup is best-effort, and `wake()` is
inert before `start()` because the startup drain picks up anything enqueued first.

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
   and recent turns, into weighted cues: query text weighs 3x, summary and recent-turn text
   1x each. The summary was damped from 2x on a measurement: summary cues compete with query
   cues for a seed budget that ran exactly full on all 1,480 logged recalls, and across four
   summaries none improved on no summary at all while one lost the answer entirely. Nothing
   rewrites or drops the caller's summary; it just stops outranking the question. If the call
   times out, errors, or returns something unparseable, recall falls
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
7. **Pack assembly.** Fused items route to a bucket by node label (`pack-buckets.ts`):
   `Episode`/`Turn` to `episodes`, `Narrative` to `narratives`, and `Entity` plus the nine
   cognitive types (`Goal`, `Plan`, `Decision`, `Insight`, `Concept`, `Context`, `Event`,
   `Pattern`, `Trend`) to `facts`, since a Decision carries a fact the same way an entity
   does. `resonant` is not in that table and never will be: every other bucket answers what
   kind of memory this is, which a label decides, and resonance answers how it was found,
   which only the stage that found it knows. A label with no bucket is dropped. Each bucket
   is capped, trimmed to the token budget, and rendered into the pack's text block. The
   episode cap (`AION_RECALL_MAX_EPISODES`)
   defaults to 20, a deliberate deviation from whitepaper Appendix E's 5: the cap cuts the
   fused list, so on a populated substrate a five-item cut is filled by near-tie vector hits
   before any traversal-reached item can land. The token budget is what actually bounds a
   pack's size. `preferences` has no producer yet, so it is structurally absent rather than
   empty. `narratives` gained one in P3: a session's close, or the idle sweep, compresses its
   episodes into a `Narrative` node. `resonant` gained one in P4: the second pass above.

8. **Session dedup.** One subtraction between the assembled candidate set and the wire. A
   per-prompt recall hook asks many times inside one conversation and the top of the ranked list
   barely moves, so the same memories are rendered again into a context that is still holding
   them (measured at nine recalls in one session, about 1,200 tokens each, heavily overlapping).
   Every item a pack renders is recorded in SQLite's `served_items` as one row per (session,
   item) carrying a fingerprint over what the item said. On the next recall in that session, an
   admitted item whose fingerprint still matches is cut from the buckets, counted in
   `metadata.suppressed_repeats`, and named in the honesty line; an item whose fingerprint moved
   (superseded, description regrown, currency changed) is told again in full. Only the wire
   shrinks: reinforcement, access tracking and the pack-method counters all still see everything
   fusion admitted, because the subtraction is about what the agent already read rather than
   about what recall found. A time-traveled read is exempt in both directions, since inspecting
   the past neither repeats a serve nor decides what the present may repeat, and
   `AION_RECALL_SESSION_DEDUP=false` restores the full pack on every call. The record dies with
   the session, on the client's DELETE or on the idle sweep, whichever reaches it.

9. **Own-session origin.** The second subtraction, and the one dedup cannot make. A turn is
   reflected into the graph when the session stops, and the next prompt's recall finds that turn
   and the claims extracted from it as memories the session has never been served, so no
   fingerprint and no served row can catch them. What separates them is where they came from. One
   batched read (`origin-queries.ts`), issued beside the related-claim lookup, answers which
   sessions each candidate's provenance names: a Turn, an Episode and a session Narrative carry
   `session_id` on the node, the nine cognitive types carry none and hang off `EXTRACTED_FROM` to
   their source episode, and an Entity hangs off neither, so its provenance is the set of episodes
   that `MENTIONS` it. An item whose provenance names the asking session and no other is cut from
   the buckets, counted in `metadata.suppressed_own`, and named in the honesty line beside the
   repeats. An item the substrate has corrected since (closed lineage, a currency marker, or the
   current claim resonance found beside a raw turn) is served in full, because the correction is
   the part the conversation does not hold. Origin decides before dedup and what it withholds
   leaves no served row, since the session never read those items. Cognition is untouched here
   too, a time-traveled read is exempt, and `AION_RECALL_OWN_SESSION_FILTER=false` restores every
   item a session produced.

Both paths inherit the driver timeouts `GraphConnection` sets: 5s to connect, 10s to acquire
a pooled connection, 10s of transaction retries. The driver's defaults (60s and 30s) meet or
exceed the MCP client's 60s request timeout, which is how a call against a stopped Neo4j
reached the caller as a client-side timeout with the server's own error lost. A healthy pool
answers in microseconds, so these bite only during an outage. See `docs/degradation.md` for
every failure mode this pipeline degrades through, mode by mode, with live evidence.

The pack is saved to SQLite's `last_pack` table (what `aion last` renders) and returned. The
row carries the read mode alongside the pack, `as_of` and `knew_at` when either was set, so
`aion last` can say the pack answered a time-traveled read rather than the present graph. A
registered listener fires afterward and is never awaited, so a listener failure cannot fail a
recall that already succeeded: it stamps access metadata and nominates the co-activated pairs
that the reinforcement flush later folds into edge weights. A time-travel read does neither,
since asking what the substrate held last month is a question rather than a use.

## Maintenance path: the introspection loop

A third path, on the service's own clock rather than on a caller's request. `Introspector`
(`introspection/application/engine.ts`) starts with the service and stops before the driver
does, and one tick runs four phases: observe, decide, act, learn.

1. **Observe.** `observeHealth` assembles one `HealthSnapshot` from the surfaces `aion
   doctor` and `/health` already read: graph structure (node population, vector parity,
   orphan share, episodes with no session link), queue (depth per lane, oldest unclaimed,
   exhausted attempts, enrichment lag), enrichment (episodes with no orchestrator ledger
   key), plasticity, proposals, entities (identities the deterministic tier-0 sweep could
   still absorb), redaction residue. Every collector is caught independently; one that
   throws names itself in `degraded` and costs its own metrics rather than the reading.
2. **Decide.** `decide` (`introspection/domain/decide.ts`) is pure: the same snapshot always
   produces the same answer, so a decision is arguable from the numbers. Tier is a property of
   the cycle rather than of the operation: an operation names the critical condition it repairs
   in `answers`, and it preempts the whole catalog unweighted on the cycles the snapshot meets
   that condition. Three conditions, each with a responder: vector parity under 0.8
   (`vector_backfill`), orphan share over 0.3 (`orphan_cleanup`), episodes with no session link
   (`emergency_relationship_repair`). Preemption is not open-ended. Past a grace of three
   resolved runs, an operation keeps preempting only while it is still moving the metric it
   declared, because a condition can stand for weeks and nothing else may wait that long. Tier
   2 scores the rest by each operation's own `relevance`, halved for an operation whose runs
   have stopped improving anything and multiplied by how many cycles it has been passed over,
   and selects the highest above `AION_MAINTENANCE_URGENCY_THRESHOLD`. Tier 3 is the
   model-guided seam: opt-in (`AION_MAINTENANCE_TIER3`), propose-only, and inert by default.
3. **Act.** At most one operation per tick. It claims a calendar-aligned time bucket in the
   ops ledger first (`intro:<name>:<bucket>:<stamp>`), so two service instances cannot run
   the same window twice, and writes the outcome back to that key when it finishes. The
   operation reads the graph, SQLite, the config, the snapshot the decision was made from,
   and a `provider` off one `OperationContext`. That provider is the `reflect` role's,
   built once for the service: an operation that built its own would get a fresh circuit
   breaker per run, which cannot count the consecutive failures it exists to trip on.
4. **Learn.** An operation declares the one metric it exists to move and which direction
   counts as better. The engine takes that reading before the run and again on a later tick,
   which is the first snapshot that can see the system settled around the change, and records
   `improved` / `unchanged` / `failed`. Those counts are the effectiveness weight step 2
   reads. An operation with no metric in the snapshot is scored on whether it applied
   anything.

The catalog is one ordered list (`introspection/application/catalog.ts`), which is the only
place an operation joins maintenance. Fourteen are registered, in four groups: substrate
hygiene (`vector_backfill`, `reconcile_reenqueue`, `dead_letter`,
`redaction_residue_purge`), plasticity (`reinforcement_flush`, `memory_decay`), content
(`narrative_cleanup`, `narrative_regrounding`, `retro_judgment_sweep`,
`description_freshness`), and topology (`emergency_relationship_repair`, `orphan_cleanup`,
`community_refresh`, `symbiosis_bridge`). List order is documentation: selection is by tier
and urgency, and ties break on waiting time and then on name.

One repair sits beside the catalog and is deliberately not in it. `entity_unmerge` splits an
absorbed identity back out of the entity it was merged into. A bad merge is not measurable
from inside the graph (a correct merge and a wrong one have the same shape), so a person
names the merge to reverse; `aion unmerge ls|apply` is where they name it.

`aion stats` renders the loop's own record: the cycle count, and per operation the runs,
the improved/unchanged/failed split, and the last window's outcome from the ledger.
`aion maintain ls` lists the catalog; `aion maintain run <name>` forces one operation now,
bypassing the relevance score and the bucket claim and nothing else. The escape hatch exists
because one operation's subject is not proportional: thirteen leaking nodes out of two
thousand is a small share to a scoring function and an incident to a person.

**Four operations the design names and this does not register.** `entity_consolidation` is a
placeholder in the design itself and waits on a measure of entity fragmentation the snapshot
does not take. `connectivity_enhance` and `association_pruning` overlap what `symbiosis_bridge`
and `memory_decay` already do to edge weight, and building a third writer of the same property
before the first two have a measured effect would make all three unattributable.
`temporal_hygiene` has no trigger: nothing in the snapshot counts a validity-period violation,
and an operation with no gauge cannot be scored or starved.

**One narrowing inside the bridge.** The design describes an LLM proposing a set of specific
node connections. This proposes the summary, rationale and compatibility, and anchors the
bridge on the closest cross-community pair by content vector rather than on a model-chosen set.
The vectors are the substrate's own statement that two nodes are about the same thing, they are
already computed, and a person can re-derive the choice from the graph months later.

## Bitemporal model

Every node carries three time concepts, all set at write time and never rewritten except
by `supersede`:

- **`occurred_at`**: when the experience happened. Defaults to the write-time clock;
  callers may backdate individual turns.
- **`valid_from` / `valid_until`**: world time, the interval during which the fact was
  true. `valid_until` absent means still current.
- **`tx_from` / `tx_until`**: system time, the interval during which the substrate held
  this belief. `tx_until` absent means still held.
- **`forgotten_at`**: the one true suppression, written by `aion forget`
  (`forgetNode` in `infrastructure/graph/bitemporal.ts`, a `SET` with a `coalesce` so a
  repeat is a no-op). Default recall hides a forgotten row; `as_of`/`knew_at` still surface
  it, which is what keeps forgetting an audited act rather than a deletion.

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

`supersedeSubjectFamily(driver, { claimId, newId })` is the middle blade
(`infrastructure/graph/subject-family.ts`), and the default an applied proposal takes. It
closes the judged claim and only those siblings of the same episode that name one of its
subjects, where a subject is an entity that episode mentioned whose stored fold appears inside
the claim's, with provenance `supersession_subject_propagation`. A definition of a neighbouring
term and a record of a benchmark stay open, which is what separates it from closing the
episode. The same call retires the description of a subject entity whose gloss names another
subject of the closed claim: an entity is never closed, since one outlives every episode that
named it, but a frozen sentence restating a claim that just closed is cleared so recall stops
serving it as a current fact.

What decides that a close should happen is two model calls, not one, and not a confidence
number. The supersession stage judges each pair (`reflection/application/stages/supersession.ts`),
and under the shipped `AION_SUPERSEDE_MODE=unanimous` every affirmative goes to a second call
that argues the other side on the same evidence and never sees the first one's reasoning
(`supersession-review.ts`). It checks two things: whether the older claim is actually made false,
since an opinion, a wider scope, and a different attribute of one subject all survive, and
whether the newer claim is coherent at all, since a garbled extraction can win a same-subject
comparison while asserting nothing. Only a unanimous pair closes, through the same
`applySupersessionProposal` path a review takes, stamped `supersession_unanimous_auto`. A veto
becomes a proposal row carrying the reason. The stage reports three outcomes rather than two,
read off the graph: closed, vetoed or proposed, and target-already-gone, the last being a
judgment whose losing side had already lost currency and which therefore closed nothing.
Confidence was the earlier gate and is not one: the judge answers 0.95 to every affirmative it
makes, and a threshold over one value gates nothing.

`unsupersedeNode(driver, { id })` (`infrastructure/graph/unsupersede.ts`) is the inverse, and
`aion unsupersede` drives it. It closes the `SUPERSEDES` edge in system time rather than
removing it, stamps `reopened_at` on it, and drops the two stamps that closed the node, so a
reopened claim reads as current, `aion why` shows the close and the reopen both, and a
knowledge-time read pinned before the reopen still reports the supersession the substrate held
then. It works on a close from any mode, since every close writes the same stamps.

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
  `knownAt`. Lineage itself is filtered to supersessions recorded by `knownAt` and still held
  then, so a knowledge-time read reports neither a correction the substrate had not made yet
  nor one it has since reopened.
- **`bitemporalAt(validAt, knownAt)`**: both predicates at once, what the substrate
  believed at `knownAt` about what was true at `validAt`.

One write is exempt from strict idempotency by design: `access-tracking.ts` bumps
`last_accessed` and increments `access_count` on every node a recall surfaces, and running
it twice for the same node doubles the count on purpose, because it is a real access, not
a retry, and should double it. Retried or duplicated *content* writes (episodes, turns,
edges) are unaffected; that guarantee holds through `MERGE`.

## Graph schema surface

**Node labels.** Seventeen primary labels, pinned in `infrastructure/graph/labels.ts`:
`Session`, `Episode`, `Turn`, `Entity`, `Member`, `Workspace`, `Narrative`, `Bridge`, and
the nine cognitive types (`Goal`, `Plan`, `Decision`, `Insight`, `Concept`, `Context`,
`Event`, `Pattern`, `Trend`). Every node also carries `AionNode`, which is what gives
type-agnostic id lookups (both edge endpoints, the supersession close) an index to seek.
Neo4j has no label-free property index, so without it those lookups would scan the whole
graph. Every content-bearing label carries `Memory` as well, which is everything above
except `Session` and the two backbone nodes, because a Neo4j vector index cannot span a
label union: `Memory` is the only mechanism that lets one vector index cover more than one
node type. The backbone nodes (`Member`, `Workspace`) stay out of `Memory` (they are
connectivity, not content) and carry `Entity` instead, so the `name_norm` uniqueness
constraint and the entity-resolution seed strategy both apply to them.

**Indexes and constraints** (migrations 001, 002 and 003,
`infrastructure/graph/migrations.ts`):

- Uniqueness constraints on `AionNode.id`, and on `.id` for every primary label except
  `Entity`, which takes `entity_name_unique` on `name_norm` alone instead. Migration 001
  covers `Session`, `Episode`, `Turn`, `Member`, `Workspace`; 002 adds `Narrative`,
  `Bridge`, and the nine cognitive types; 003 drops the composite `(name_norm, type)`
  constraint the entity key used to carry. One name is one identity whatever type the
  extractor picked for it, and `type` follows counted readings as an ordinary property.
- One range index, `entity_name_squash_idx` on `Entity.name_squash`, the separator-stripped
  second lookup key. Never a uniqueness rule and never a write-time route: `re-mark` and
  `remark` squash together and are two words, so squash equality is evidence the dedup
  cascade weighs into a merge that carries a provenance record and an undo.
- Two vector indexes, `content_vec_idx` and `context_vec_idx`, both `FOR (n:Memory)`, both
  cosine similarity at the configured embed dimension (1024 by default,
  `snowflake-arctic-embed2`).
- Two range indexes, `memory_valid_until_idx` and `memory_tx_until_idx`, both
  `FOR (n:Memory)`. They serve the bounded half of a time-travel filter
  (`valid_until > t`); the open-interval half (`IS NULL`) has no index to seek and is a
  scan by construction.
- One fulltext index, `memory_content_fts`, over `Episode|Turn|Entity|Narrative` plus the
  nine cognitive labels, `ON EACH [summary, text, name]`, the target of the `bm25` seed
  strategy. `Bridge` is the one `Memory` label it leaves out. It replaced migration 001's
  narrower `content_fts` under a new name rather than
  by a drop-and-recreate: `runGraphMigrations` replays every statement on every `aion init`,
  so a rename is what keeps a re-init from destroying and repopulating a healthy index.

**Edge merge policy** (`infrastructure/graph/edges.ts`). Every relationship write goes
through one `MERGE`, matched on endpoint ids resolved through `AionNode`: on create it
sets strength, confidence, signal and provenance lists, and a count; on match it takes
`max(strength)`, `max(confidence)`, set-union on signals, set-union on provenance,
`sum(count)`, and refreshes `updated_at` while leaving `created_at` alone. The five
undirected types (`SIMILAR`, `CO_OCCURS`, `RELATED_TO`, `ANALOGOUS_TO`, `CONTRADICTS`)
normalize their endpoint order before the merge, so writing an edge from node A to node B
and later from B to A lands on one edge, not two. `CONTRADICTS` is undirected because
tension is mutual: two claims in tension state the same thing from either end.
Twenty-two directed types cover containment
(`PARTICIPATES_IN`), temporal chaining (`FOLLOWS`, `PRECEDES`), provenance
(`DERIVES_FROM`, `EVIDENCES`, `EXTRACTED_FROM`), the backbone (`HAS_MEMBER`,
`HAS_WORKSPACE`), and this build's bitemporal extension, `SUPERSEDES`.
