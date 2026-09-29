# Architecture

How this repo is put together: packages, the read and write paths, the maintenance loop, and
the graph schema. For what the system is and why it is built this way, see
[whitepaper.md](whitepaper.md), which also lists where this build departs from the design it
came from.

## Packages and dependency direction

`protocol` is the leaf: Zod schemas for the four tool contracts, recall (`recall-input`,
`recall-output`, `recall-result`), reflection (`reflection-input`, `reflection-output`), and the
two read-only source tools, `source_search` and `source`, both held in `source-search`, plus
`history-coverage` and shared types (`IsoTimestampSchema`, `CurrencySchema`,
`SupersededBySchema`). It imports nothing from the rest of the workspace.

`core` depends on `protocol` for wire schemas and nothing else in the workspace. `mcp` and
`cli` both depend on `core` (and transitively on `protocol`). The dependency between the
top two runs one way: `cli` imports operational constants from `mcp` (the health
path, the container check, the usage protocol, and `reflectionStages`, the same pipeline stage
list the service registers, so `aion replay` and `aion timeline` run the stages the worker runs),
and `mcp` imports nothing from `cli`.

## Bounded contexts inside core

Each context that has both pure logic and orchestration splits into `domain/` and
`application/` (everything that touches the graph, SQLite, or a model). `domain/` is not free
of infrastructure: thirty-nine of its modules import from `infrastructure/`, most for type-only DI
contracts (`Config`, `Logger`, `Driver`, `SqliteHandle`, `Provider`, the shape `operation.ts`
and `stage.ts` declare for what a stage or operation receives). Two cross into value coupling:
`introspection/domain/proposal-hygiene.ts` imports the `DEFAULTS` config object and reads two
of its fields as fallback horizons, and `introspection/domain/tier3.ts`'s `proposeOnlyAdvisor`
takes a `Logger` and calls `logger.info`, I/O executed from inside domain code rather than
merely typed against it. What still holds: `domain/` never imports `application/`;
`application/` imports `domain/` and `infrastructure/`. `infrastructure/` reaches into two
contexts. It takes pure identity and content primitives from `reflection/domain/` across
twenty-two files (name folding, claim keys, vector-input hashing, entity-extraction and
entity-reconciliation helpers, two value types), and one ownership-scope constant from
`evidence/domain/ownership.ts` in `sqlite/probe-incidence.ts`; it holds no application code and
no notion of episodes, cues, or memory packs beyond those primitives.

- **`infrastructure/`**: `graph/` (every Cypher statement in the workspace), `sqlite/`
  (the reflection queue, the experience archive `aion replay` and `aion timeline` read,
  the insert-only usage stream `aion replay usage` puts back, last-pack cache, the served-item
  record, ops ledger, claim locking, and the two proposal
  queues, whose reads share one `proposal-table.ts` because both are an id, the pair the
  proposal is about, and a `resolved_at` that is null while the row is still undecided),
  `providers/` (the Ollama, Anthropic and OpenAI clients, each provider's batch transport,
  the retry rule and circuit breaker both remote routes share, the daily spending guard, the
  per-role routing layer and the model reconciliation that follows it), `publication/` (the
  coordinator every two-store write goes through: the guard a plan is prepared under, the
  precondition and evidence-revision check, the short SQLite transaction, the graph apply, the
  acknowledgment that completes the declared effects, and the crash recovery that finishes a
  prepared attempt), `config/` (schema, defaults, the `AION_*` registry, the loader),
  `logging/`.
- **`recall/domain/`**: `activation.ts` (spreading activation over adjacency),
  `activation-weights.ts` (the per-relationship-type propagation table),
  `admission.ts` (the evidence rules and the floors), `arrival-scoring.ts` (cosines for what
  the spread reached), `seed-selection.ts` (the budget curve and the per-leg reservations),
  `fusion.ts` (weighted RRF, the admission decision, and the currency policy),
  `path-admission.ts` (the disclosed path-strength lane, after `fuse`'s ordinary gate has
  refused everyone), `ranking.ts`
  (the ordering machinery fusion hands its admitted list to: MMR, the near-duplicate cluster
  cap, cosine), `facts.ts` (the restatement floor and the gloss cap), `resonance.ts` (the
  centroid and the shape of a resonant item), `intention-triggers.ts` (whether a standing
  intention's condition is met by what the run already holds), `pack-buckets.ts` (which bucket a
  node label answers in), `pack.ts` (MemoryPack assembly).
- **`recall/application/`**: `cues.ts` (the query cues every mode searches with, and the
  `cues` mode's extraction and its cache), `seeds.ts` (the
  five seed strategies' scoring and merge), `candidates.ts` (seeds plus activation into
  ranked lists), `stage-reads.ts` (the pipeline's batched graph reads), `resonance.ts` (the
  second pass), `intentions.ts` (the third), `assessment-pool.ts` and `assessment.ts` (what the
  `assess` mode's model call is shown and how its answer is served), `recall.ts` (the
  pipeline), `side-effects.ts` (post-recall listeners).
- **`plasticity/`**: `domain/` folds a window of co-activation signals into per-pair
  learning rates and computes the staleness curve; `application/` runs the two operations
  that apply them, `flush.ts` (bounded reinforcement of the nominated pairs) and `decay.ts`
  (weight decay against staleness, the protected relationship types exempt), plus
  `metrics.ts`. Decay is called and never scheduled: its cadence belongs to the caller.
  Reinforcement has a clock of its own (`drain.ts`): `ReinforcementDrain` is the queue's one
  consumer and `ReinforcementCadence` runs it every five seconds
  (`AION_HEBBIAN_DRAIN_INTERVAL_MS`). The maintenance operation still exists and delegates to
  the same owner, so a manual `aion maintain` and the service's timer cannot read the same
  oldest bursts and apply one window twice: the queue's claim is a SELECT rather than an
  exclusive claim, and one owner is what stands in for that.
- **`introspection/domain/`**: `health.ts` (the snapshot every phase reads, plus the critical
  conditions read off it), `decide.ts` (the pure three-tier decision, starvation protection,
  effectiveness weighting, the preemption grace), `operation.ts` (the contract a maintenance
  operation implements), `bridge-pairs.ts` (which two communities a bridge should join),
  `buckets.ts` (calendar-aligned idempotency keys), `tier3.ts` (the model-guided seam, on by
  default and propose-only).
- **`introspection/application/`**: `observe.ts` (one health reading), `engine.ts` (the
  tick loop: bucket claim, run, learn, backoff), `catalog.ts` (the registration seam),
  `plasticity-operations.ts` (the flush and the decay sweep, adapted to the contract), and
  `operations/`, one file per registered operation plus `unmerge.ts`, the repair the loop
  never selects on its own.
- **`reflection/domain/`**: `content.ts` (episode/turn shaping and content hashing),
  `stage.ts` (the contract every stage implements and how the orchestrator records it),
  `name-fold.ts` (the identity fold behind `name_norm` and every embedding call),
  `entity-extraction.ts`, `entity-identity.ts` and `entity-merge.ts` (the name-form half of
  identity and the grouping a dedup run reduces to), `associations.ts` (pair combinatorics and
  what one co-occurrence birth is worth), `synthesis.ts` and `preferences.ts` (what each
  inference pass reads, what a usable answer is, and the key it is reconsidered under),
  `context-vector.ts` (the strength-weighted mean), `narrative.ts` (the session boundary and
  versioning rules).
- **`reflection/application/`**: `intake.ts` (the write path), `worker.ts` (claims queue
  rows and runs the orchestrator), `orchestrator.ts` and `stages/` (the enrichment
  pipeline), `narratives.ts`, `lanes.ts`, `vectors.ts` (pending-vector backfill),
  `reconcile.ts`, `lag.ts`, `proposals.ts`.
- **`redaction/`**: `entropy.ts`, `rules.ts`, `deep-walk.ts`, `redact.ts`,
  `fingerprint.ts`, `residue.ts`. Deterministic and rule-based by design: the one place
  inference is deliberately not used, because a credential leak cannot wait on a model's
  judgment.
- **`evidence/`**: `domain/` (the scope vocabulary, the read budget, and the shape of a
  resolved answer); `application/` (`resolver.ts`, the read that answers what a node's
  provenance supports, plus `judgment.ts`, `lineage-walk.ts`, `node-support.ts`,
  `narrative-support.ts`, `node-state.ts`, `ownership.ts` and `merge-recovery.ts`). Recall's
  serving view and the maintenance loop's provenance questions both read through it.

  A judged pair is entitled to two things about each side: the source occurrences the node's own
  family reaches, and the reading of the node the statement belongs to. Both are counted from
  birth. The write that mints a node establishes the censuses on it and records the relationship
  it made (`reflection/application/derived-node-evidence.ts`), which is honest because the id was
  drawn by that write and nothing else can have recorded anything about it. Seven producers reach
  it: intake for an episode and its turns, the entity and cognitive stages for what they extract,
  the synthesis and preference stages for what they infer, `curiosity` for the question it files,
  and claim consolidation for the claim it derives, which
  names every source its members already carry rather than a capture of its own. The backbone is
  minted before any coordinator stands: `aion init` bootstraps the Member, the Workspace and the
  Substrate with a creation mark, and the service start establishes their censuses
  (`reflection/application/backbone-evidence.ts`). A backbone node an older build minted carries
  no mark and keeps the gap it has. `node-state.ts`
  owns the second half: the same write establishes `graph.node_state` and its mirror, and every
  later writer that changes the node's semantic state advances the same counter in the
  acknowledgment that made the change — a forget, an orphan suppression, a family repair, and an
  applied or auto-closed supersession. A pair whose sides carry neither is not judged; the judge
  is not asked at all, and the work is reported as withheld with the scope that blocked it.

  An entity pair is entitled to less of the first thing, because an entity's history only grows:
  reading every source of both sides whole was a budget no well-known entity could meet. Each side
  gets a bounded, disclosed selection instead (`entity-excerpts.ts`). Up to twelve sources are
  nominated per side: the episode that prompted the comparison, then stated corrections, then
  sources both entities share, then each side's newest. Each is shown as a window around the name
  from one part, and that part is decoded alone and verified against its recorded digest. The
  judge's input counts what was not read and what could not be shown, and says why. The censuses
  above still gate the pair, and the revision still binds every scope and source consulted. Claim
  pairs keep every source whole.
- **`session/`**: `session-manager.ts`, identity-to-session-id resolution, cached per
  process, backed by `infrastructure/graph/sessions.ts`.

`prompts/` sits beside those contexts and belongs to none of them: it holds every generation
system prompt the workspace runs, one file per surface, nineteen of them, plus `frame.ts`. Each
prompt is one exported constant named for what it asks. Surfaces used to export their text twice,
as `LOCAL` and `KEYED`, from when a small local model served some generation; every provider the
service builds now reports the one remote model, so the local name was an alias on most surfaces
and unreachable text on three (`description-freshness`, `supersession-judge`,
`supersession-review`). The aliases are collapsed with both callers moved onto one name, the
three texts are gone with a line in each file saying what stood there, and
`prompt-surfaces.test.ts` sweeps the directory so a route-specific name cannot come back
unnoticed. The quality harness imports these same constants instead of holding copies, so what
it scores is what the stages send. `no-stray-system-prompt.test.ts` scans `packages/` for a
system prompt declared anywhere else.

`frame.ts` is the one text no surface writes: what Aion is, what episodes and claims and entities
are for, how experience becomes revisable understanding, why provenance matters, when inferring
and revising and declining are each useful, and the authority boundary that memories and tool
results are evidence rather than instructions. Two renderings of one versioned frame, concise for
the surfaces that read fixed text and full for the surfaces that decide something, allocated by
surface in that file. The request builder puts it in front of every call
(`infrastructure/providers/request-blocks.ts`), so no prompt file mentions it and no task text
changed to get it. Measured against `claude-haiku-4-5` with the API's own counting endpoint on
2026-09-13: concise 161 tokens, full 372, against a 4,096-token caching floor. Both are
deliberately the short mode, so neither carries a cache marker today; the composition attaches
one, written for the hour, the day a frame does reach the floor.

Cross-context imports run in one direction, context by context, and nothing crosses back into
`recall/domain/`. `introspection/` is the heaviest importer: from `reflection/` it reaches
queue lag, reconciliation, vector backfill, narrative cleanup and rollup, claim consolidation,
and the entity-merge and dedup machinery `merge_auto`, `merge_decision_reconcile`,
`retro_judgment_sweep` and `structural_discovery` read directly, across both `domain/` and
`application/`. It also reaches `redaction/` (residue scanning, fingerprinting, the redact
call) and `plasticity/` (the flush and decay operations and their metrics). `recall/domain/`
takes `hashContent` from `reflection/domain/content.ts` in `fusion.ts`, `pack.ts`, `ranking.ts`
and `session-dedup.ts`, and `weightedMeanVector` from `context-vector.ts` in `resonance.ts`.
`recall/application/stage-reads.ts` adds two more, `orchestratorLedgerKey` and
`PIPELINE_VERSION`, both from `reflection/`. `recall/application/recall.ts` also imports
`redactPayload` from `redaction/deep-walk.ts` and `SessionManager`'s type from `session/`.
`reflection/application/` imports from `plasticity/domain/reinforcement.ts` (the
co-extraction trigger and the clique discount), from `redaction/` (fingerprinting and the
same `redactPayload`), and from `session/`. `infrastructure/` reaches `reflection/domain/` for
the same primitives noted above, and `evidence/domain/ownership.ts` for one scope constant.

## Write path: reflection intake

`handleReflection` (`reflection/application/intake.ts`) runs these steps in order:

1. Parse the payload against `ReflectionInputSchema`; reject anything that fails.
2. Split off `session_id`, `lane`, `origin`, `provenance` and `feedback`. None of them is
   content, so none reaches the hash or the redaction walk: identity and lane are routing,
   `origin` is provenance about the call, and `provenance` and `feedback` are statements about
   other memories. Folding any of them in would turn one experience pushed two ways into two
   episodes. `provenance` and `feedback` are redacted on their own paths
   (`redactProvenance`, `redactFeedback`).
3. Redact the remaining payload (`redactPayload`): every string field in `turns`,
   `tool_executions`, and `observations` is walked and scanned against the rule set and an
   entropy threshold; matches are stripped and logged, never stored.
4. Resolve the session (`ensureSession`), reusing a cached identity-to-session-id mapping
   when one exists.
5. Shape the payload into one episode and its turns (`prepareEpisode`), each carrying a
   sha256 content hash over a canonically key-sorted JSON encoding.
6. Read the lane the arrival rate assigns and the interactive-lane depth, then publish one
   `intake` operation through the publication coordinator (`publishIntake`,
   `intake-transport.ts`). Every durable write the acceptance itself makes happens inside that
   operation (`intake-publication.ts`): `handleReflection` no longer writes the episode, the
   archive row or the queue row on its own. What it still writes outside the operation is the
   session backbone from step 4, the caller's recall-feedback rows, and the content vectors in
   step 11.
7. Under the coordinator's guard, `prepare` decides which source this payload is, keyed on
   `(experienceArchiveKey(identity, contentHash, ARCHIVE_SCHEMA_VERSION), sessionId)`. A new
   occurrence mints a source id and one turn id per turn; a held one answers with the original
   id and projects no episode; an ambiguous or state-uncertain key is pinned and refused
   outright, because picking one of two live occurrences would record a decision nobody made.
   The same pass classifies the references the push stated.
8. The acceptance then runs in a fixed order. The SQLite prepare writes the source manifest,
   the archive row, the turn ids and the reference acceptance. `applyGraph` projects the
   stamped `Episode` and each stamped `Turn` under the ids already minted, with the session
   node locked first, and links `Turn -[:PARTICIPATES_IN]-> Episode`,
   `Episode -[:PARTICIPATES_IN]-> Session`, and `Turn -[:FOLLOWS]-> <previous Turn>`, plus the
   reference edges. The SQLite acknowledgment activates the manifest, enqueues the `integrate`
   job (`enqueueSourceWork`) and acknowledges the references. The enqueue is an acknowledgment
   effect, so no worker can claim a job for an episode that does not exist. A rejection or a
   deferral raises `ReflectionNotStoredError` rather than telling a client its reflection
   queued. `aion replay` reads the archive back through the pipeline, and `aion timeline` reads
   one episode across the archive, the graph, the queue, and the ledger.
9. If a new job was enqueued, call the `onJobEnqueued` callback so the worker can start
   immediately. The service wires that callback to `worker.wake()`; the SQLite row is what a
   restart replays from regardless. A callback that throws is logged and swallowed, since by
   then the episode is in the graph and the job is in the queue.
10. Return `{ episode_id, queued: true }` plus the assigned `lane` and `pending_ahead`
    (unclaimed interactive jobs ahead at enqueue time).
Nothing here embeds. The acknowledgment writes an `attach_vectors` row beside the integrate
job, in the acceptance's own lane, and the worker runs it: a `:Memory` node without its
`content_vec` property is the pending marker, and the queued row, the worker's startup drain and
the `vector_backfill` operation are three ways to clear it. Until one of them does, the episode
is reachable by BM25, entity resolution, recency and traversal.

A Neo4j outage during the publication still refuses honestly with `ReflectionNotStoredError`:
nothing is half-written, and the message says the experience was not kept. An Ollama outage
costs the caller nothing at all: it never reaches the intake path, and the queued row retries on
its own backoff. `docs/degradation.md` holds the live-verified behavior for both modes.

A caller's stated provenance (a source, a `CORRECTS` reference, a confirmation) is part of the
acceptance rather than a best-effort tail. `classifyStatedReferences` resolves every reference
against the substrate under the same guard the occurrence is decided under, and the acceptance
records what did and did not resolve. `projectAcceptedReferences` writes the idempotent edges in
the same graph phase as the episode, and the acknowledgment settles the batch. A reused
occurrence still accepts the statements a later push carries: a reference against a source that
is already here, or already evicted, is what the contract exists for. `settleStatedReferences`,
the worker-replay path this used to take, is retained as a shape and called by nothing. A
caller's stated feedback splits in two, deliberately. Delivery and use are self-reports in the
`feedback` block, appended idempotently to the same local database and best-effort: nothing
acknowledges them, so a failed append is logged and swallowed rather than failing an experience
that is already durable. A confirmation is evidence and arrives under
`provenance.confirmations` instead. Its append is settled against the same durable version the
references are, so an append that fails leaves the references unacknowledged and the worker
replays them, and a completion race between a duplicate push and a job finishing cannot drop it.

No generation call happens after step 7. Extraction, turning an episode into entities,
associations, cognitive structure and narratives, is a separate pipeline. `ReflectionWorker`
runs its own claim loop and `wake()` pumps it; the wakeup carries no job, so a wakeup for a
row another worker already took costs one empty claim attempt and nothing else. The worker
then runs `ReflectionOrchestrator` over the stage list `packages/mcp/src/bootstrap.ts`
registers. Eleven stages, in the order `pipeline.ts` holds: entity extraction, entity dedup,
associations, cognitive extraction, semantic relationships, supersession, reflective synthesis,
preference inference, reinforcement enqueue, context vectors, narrative evaluation. Synthesis
runs after supersession, so the conclusions it draws are drawn over claims whose currency the run
has already settled, and before context vectors, which is what makes a fresh conclusion a
resonant citizen rather than a node that can never acquire a context vector. The wakeup is best-effort, and `wake()` is inert before `start()` because the
startup drain picks up anything enqueued first.

Which row it claims is a scheduling decision, not insertion order. Every row carries a lane
(`interactive` by default, `bulk` when the caller flagged it or the arrival-rate backstop
demoted the session), the session it belongs to, and its turn within that (lane, session)
group. `claimNext` orders by lane first, then turn, then insertion, so the bulk lane never
runs while an interactive job is claimable, and inside a lane the sessions interleave. The
turn is stamped at enqueue rather than computed at claim time: a window function over the
unclaimed rows renumbers every group as rows leave it, which collapses the interleave back
into first-in-first-out after the first claim.

## Read path: recall

`handleRecall` (`recall/application/recall.ts`) runs these stages in order. Recall spends at
most one generation call, and `AION_RECALL_MODE` says where: `assess`, the default, spends it
after retrieval on choosing what helps; `cues` spends it before retrieval on extracting search
cues; `raw` spends none. The stages timed into the pack's `stage_timings_ms` are `cues`,
`embed`, `seeds`, `activation`, `fusion`, `resonance`, and `assessment` when the `assess` mode
ran it. `resonance` is always timed, even on a run that declines to search; the schema keeps it
optional only so packs written before the stage existed still parse. The intention pass,
assembly, and the three subtractions below it carry no timing.

1. **Cues.** Under `assess` and `raw`, the cues are the caller's own query at weight 3 and its
   summary at weight 1, with no model in between (`queryCues`). Under `cues`, one generation
   call turns the query, and optionally a summary and recent turns, into weighted cues at the
   same weights, and the raw query always leads the list. The summary was damped from 2x on a
   measurement: summary cues compete with query cues for a seed budget that ran exactly full on
   all 1,480 logged recalls, and across four summaries none improved on no summary at all while
   one lost the answer entirely. Nothing rewrites or drops the caller's summary; it just stops
   outranking the question. A `cues` call that times out, errors, or returns something
   unparseable falls back to the raw-query cues, and the pack records that degradation.
2. **Embed.** Every cue is embedded in one batched call. A failure here costs recall its
   vector leg only; BM25 and exact entity resolution still run on cue text. The pack records
   that rung too, so a full Ollama outage is legible as a thinner ranking rather than a model
   failure.
3. **Seeds.** Five strategies run together: `vector` (nearest neighbors in the content
   vector index), `context_vector` (nearest neighbors in the context vector index, the same
   cue embedding against a second index; it reports as a `vector` hit downstream, since it is
   one leg searching a second index rather than a method of its own), `bm25` (the fulltext
   index), `entity_resolution` (exact and fuzzy name match against `Entity` nodes), and
   `recency` (a `tx_from`-ordered fallback for a substrate with no access history yet, which
   also orders a memory only the asking session produced behind every other source, before its
   own `LIMIT`; a historical read, a call that resets delivery suppression and
   `AION_RECALL_OWN_SESSION_FILTER=false` all exempt it).
   Candidates merge by node id; a node found
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
   MMR reranking when `AION_SEARCH_RERANKER=mmr`. Ranking and admission are separate. An item
   reaches the pack only on absolute evidence: a cosine at or above
   `AION_VECTOR_ADMISSION_FLOOR`, a Lucene match on the verbatim cue or an exact entity name, or
   two independent measurements at or above `AION_CORROBORATION_FLOOR`, however well it ranks.
   Traversal is not one of them and no caller may make it one. A narrow fourth door runs only
   after those three refuse: an activation-only arrival carrying a strong inbound `CONTRADICTS`,
   `SUPERSEDES` or `CAUSES` edge above `AION_TYPED_ADMISSION_ACTIVATION_FLOOR` is judged at the
   corroboration floor instead of the vector one (`AION_RECALL_TYPED_ADMISSION`, on by default).
   `AION_BM25_ADMISSION_MODE=any` is the operator's escape hatch that lets a plain lexical hit
   admit alone. One node several legs found merges into one candidate here, scored once and
   explained by its strongest leg; two different nodes carrying the same sentence both go
   through, because whether they are one claim is decided in assembly, at step 11. An item the
   spread reached and no strategy seeded is scored against the query cues on its own content
   vector. A fifth, disclosed door runs last, over whoever the first four refused for want of any
   measurement at all: the path-strength lane (`path-admission.ts`) admits up to
   `AION_RECALL_PATH_STRENGTH_SLOTS` (default 2) of the strongest-activation arrivals per pack,
   marked `path_strength` in `admitted_by` so a reader sees which door they came through. It is
   not a floor rule and never competes with one; the floors refuse a candidate first, every time,
   and the lane's own knob at 0 leaves the pack exactly as the four-door gate alone would produce.
6. **Context resonance.** A second pass, after fusion so it can exclude what the first pass
   already produced rather than because it depends on what fusion admitted: the
   activation-weighted mean of the activated set's context vectors becomes a query against the
   context vector index, above `AION_CONTEXT_RESONANCE_CONTEXT_SEARCH_THRESHOLD` and excluding
   every id the first pass already produced. The mean excludes a structural node and a node no
   cue-seeded path contributed activation to (the spread carries that support outward from the
   seeds and the centroid reads it), so it also runs, on purpose, when fusion admitted nothing at
   all but the spread still found something real. What comes back is
   related by the shape of its neighborhood rather than by its words, so it lands in `resonant`
   under its own rationale and never competes with a fused score. The stage is skippable
   (`AION_RECALL_USE_CONTEXT_RESONANCE`), timed like every other stage, and declines to run only
   when nothing but recency or structural plumbing activated.
7. **Intention triggers.** A third pass, after resonance because it reads that stage's
   centroid. One bounded read of the open intentions that carry a trigger condition, then three
   comparisons per row against what the run already holds: the subject entity in the activated
   set (`entity`), a named date the clock has passed (`temporal`), or the source episode's
   content vector against the centroid above `AION_RECALL_INTENTION_SITUATION_FLOOR`
   (`situation`). No model call and no embedding, so the hot path keeps at most one generation
   call. A match lands in `intentions` with method `intention_trigger` and the path that fired
   it. Provenance decides the bucket, not the label: a Goal the query itself found stays in
   `facts`, and only a trigger moves one here. `AION_RECALL_INTENTIONS=false` turns the stage
   off, and a time-traveled read evaluates no trigger at all, since a trigger is the substrate
   acting now.
8. **Pack assembly.** Under `assess`, the evidence is read first, and then the recall model
   is shown what retrieval found (`assessment-pool.ts`): the admitted candidates, then items the
   floors refused, then the resonant associations and the triggered reminders in slots of their
   own. The pool holds as many items as the pack has slots, and leaves out anything the session
   already holds or wrote itself. The model answers with candidate numbers, most useful first,
   and at most one short note. A valid selection is the pack, whatever it holds: its items keep
   their buckets and their own standing, and a refused item it chose says in its admission that
   the floors did not pass it. The host checks identity, never judgment, so a number that names
   no candidate is dropped. A call that produces no usable answer serves the ranking assembly
   below, marked `degraded: assessment`. Under `cues` and `raw`, that ranking assembly is the
   pack.

   Fused items route to a bucket by node label (`pack-buckets.ts`):
   `Episode`/`Turn` to `episodes`, `Narrative` to `narratives`, and `Entity`, `Bridge`, plus the
   nine cognitive types (`Goal`, `Plan`, `Decision`, `Insight`, `Concept`, `Context`, `Event`,
   `Pattern`, `Trend`) to `facts`, since a Decision carries a fact the same way an entity
   does, and `Synthesis` to `facts` as well, since a drawn conclusion is what the substrate
   knows. `resonant` and `intentions` are not in that table and never will be: every other
   bucket answers what kind of memory this is, which a label decides, and those two answer how
   it was found, which only the stage that found it knows. A label with no bucket is dropped.
   Each bucket is capped, trimmed to the token budget, and rendered into the pack's text block.
   The episode cap (`AION_RECALL_MAX_EPISODES`)
   defaults to 20, a deliberate deviation from whitepaper Appendix E's 5: the cap cuts the
   fused list, so on a populated substrate a five-item cut is filled by near-tie vector hits
   before any traversal-reached item can land. The token budget is what actually bounds a
   pack's size. `preferences` gained its producer when preference inference joined the pipeline:
   a `Preference` node routes there and nowhere else, capped at `AION_RECALL_MAX_PREFERENCES`,
   and it is the only label whose bucket is named after it. `narratives` gained one when a
   session's close, or the idle sweep, compresses its episodes into a `Narrative` node. `resonant` gained one from the second pass above, and
   `intentions` from the third. Each item also carries standing, one word read off the node's
   label and any stated evidence (`said`, `decided`, `inferred`, `captured`, `summarized`,
   `described`, `concluded`; attribution to a person needs a confirmation record naming who and
   where it was written down, a recorded role reads as `reported`, and everything else as
   `unknown`, never a retrieval score). A `Synthesis` serves as `concluded` and a `Preference` as
   `inferred`, both always with attribution `unknown`: nothing on either path writes a
   confirmation, so a preference the substrate served and an agent then restated cannot come back
   as evidence for itself, and derivation, up to three root sources with `shared_with` naming a
   sibling item that traces to the same root. A caller can also state a `CORRECTS` reference
   against a node it names outright. Superseded material is laid down after current
   material, across every population, so a current answer takes the budget first, and it marks
   `successor_absent` when its replacement did not also reach the pack. A historical read
   (`as_of`/`knew_at`) still renders standing and provenance, at the vantage it asked about; what
   it is exempt from is ordinary successor preference, the deferral of superseded material and the
   `successor_absent` marker, since what the substrate held then is the question there.

9. **Session dedup.** One subtraction between the assembled candidate set and the wire. A
   per-prompt recall hook asks many times inside one conversation and the top of the ranked list
   barely moves, so the same memories are rendered again into a context that is still holding
   them (measured at nine recalls in one session, about 1,200 tokens each, heavily overlapping).
   Every item a pack renders is recorded in SQLite's `served_items` as one row per (session,
   item) carrying a fingerprint over what the item said. On the next recall in that session, an
   admitted item whose fingerprint still matches is cut from the buckets, counted in
   `metadata.suppressed_repeats`, and named in the honesty line; an item whose fingerprint moved
   (superseded, description regrown, currency changed, its standing changed with a confirmation
   recorded or a correction stated, or the current claim standing beside a raw turn replaced) is
   told again in full. Ranking is untouched: fusion still measures everything it admitted, the
   admission report still counts the whole set, and the retrieved population the usage stream
   records is still the union of all three passes. The subtraction is about what the agent
   already read rather than about what recall found. Reinforcement and access tracking are a
   different question and follow the pack: both are charged only against what it emitted, so a
   withheld repeat earns neither. A time-traveled read is exempt in both directions, since inspecting
   the past neither repeats a serve nor decides what the present may repeat, and
   `AION_RECALL_SESSION_DEDUP=false` restores the full pack on every call. The record dies with
   the session, on the client's DELETE or on the idle sweep, whichever reaches it.

10. **Own-session origin.** The second subtraction, and the one dedup cannot make. A turn is
    reflected into the graph when the session stops, and the next prompt's recall finds that turn
    and the claims extracted from it as memories the session has never been served, so no
    fingerprint and no served row can catch them. What separates them is where they came from. One
    batched read (`origin-queries.ts`), issued beside the related-claim lookup, answers which
    sessions each candidate's provenance names. A Turn, an Episode and a session Narrative carry
    `session_id` on the node. The nine cognitive types carry none and hang off `EXTRACTED_FROM` to
    their source episode, and an Entity hangs off neither, so its provenance is the set of episodes
    that `MENTIONS` it. An item whose provenance names the asking session and no other is cut from
    the buckets, counted in `metadata.suppressed_own`, and named in the honesty line beside the
    repeats. An item the substrate now holds evidence about is served in full instead: closed
    lineage, a currency marker, the current claim resonance found beside a raw turn, a `CORRECTS`
    reference somebody stated against it, or a confirmation naming a confirmer. None of those move
    the item's capture origin, and all of them are the part the conversation does not hold. The
    evidence is read off the provenance the run already fetched, so an item that read answered for
    with nothing to say is suppressed as usual, and an item it could not answer for at all is
    preserved. Withholding on a failed lookup would assert the session already knows something
    nobody could read. Origin decides before dedup, and what it withholds leaves no served row,
    since the session never read those items. That is why the fingerprint cannot repair this on
    its own. Ranking is untouched here too, a time-traveled read is exempt, and
    `AION_RECALL_OWN_SESSION_FILTER=false` restores every item a session produced. A compaction
    re-prime is the second exemption, and it is the premise being withdrawn rather than a setting:
    the same `reset_delivery_suppression` that makes recall forget what it served makes it stop
    calling that session's captures its own, for the one call that sends it. A conversation whose
    transcript was summarized is not holding those turns any more, so there is no echo to spare it.

    That batched read is the branch the pipeline takes on its own. A covered entry point hands
    the resolver a checked context instead, and the resolver answers from the durable records:
    the incidence rows that carry a node, and the source record behind the id it holds itself.
    That answer stays `unknown` until all three ownership scopes on the node carry a census, and
    `unknown` serves. The acceptance counts those three for every episode and turn id it mints, so
    a raw capture is withheld from the session that wrote it on either branch. A claim, an insight
    or an entity is counted by the write that derived it: the extraction stages record the
    relationship they made and the censuses a minted id is entitled to, so their session set is
    the one their own sources carry.

11. **Near-duplicate fold.** The third subtraction, decided inside pack assembly itself rather
    than against a served-items record, and the only place two different node ids are ever read as
    one claim. Fusion merges by id and nothing else: two ids carrying one sentence both reach
    assembly, because whether they are one memory is a question about standing, subject identity
    and the substrate's own key, and none of those are answered until the provenance read comes
    back. `near-duplicate-queries.ts` groups a pack's candidates by subject key and stored text
    fold (`text_norm`), the same identity the substrate already keys a claim node on. It excludes
    a whole group's member from folding wherever a `SUPERSEDES` or `CONTRADICTS` edge says the
    substrate holds two of its members apart (the rest of the group still folds among itself).
    No cosine decides this: measured against the shipped embedding model, a one-digit change to
    an otherwise-identical sentence reads a higher cosine (0.997) than a genuine rewording of one
    claim does (0.788), so no floor separates the two populations. `pack-duplicates.ts` withholds
    a nominated pair only when both sides answered for provenance, share currency, standing kind
    and attribution, and neither is contested (no `supersededBy`, no related-current-claim
    annotation, no stated correction). Assembly folds an
    item only in favour of one already placed, walking its own serving order, so a held-back item
    can never itself hold another back. Counted in `metadata.suppressed_duplicates` and named in
    the honesty line. Unlike the two subtractions above, a folded item leaves no `served_items`
    row, since the session was never shown it, so a later recall is free to offer it.
    `AION_PACK_DUPLICATE_SUPPRESSION=false` is the kill switch, and it turns the fold off without
    licensing a pack to print one node twice: the same id reached by two passes is still placed
    once, which is identity rather than a fold.

    The near-duplicate cluster cap in `ranking.ts` is a separate rule and runs earlier, before
    assembly sees anything. It is a crowding limit on how many members of one near-identical
    cluster a ranked list may carry (`AION_PACK_CLUSTER_CAP`, keyed on a text prefix and on cosine
    where vectors are loaded), it counts its own loss in `dropped_near_duplicate`, and it makes no
    claim about two records being one claim. So not every admitted candidate reaches assembly, and
    the promise here is one explicit claim-equivalence policy rather than a guarantee that every
    retrieved record is judged by it.

Both paths inherit the driver timeouts `GraphConnection` sets: 5s to connect, 10s to acquire
a pooled connection, 10s of transaction retries. The driver's defaults (60s and 30s) meet or
exceed the MCP client's 60s request timeout, which is how a call against a stopped Neo4j
reached the caller as a client-side timeout with the server's own error lost. A healthy pool
answers in microseconds, so these bite only during an outage. See `docs/degradation.md` for
every failure mode this pipeline degrades through.

The pack is saved to SQLite's `last_pack` table (what `aion last` renders) and returned. The
row carries the read mode alongside the pack, `as_of` and `knew_at` when either was set, so
`aion last` can say the pack answered a time-traveled read rather than the present graph. A
registered listener fires afterward and is never awaited, so a listener failure cannot fail a
recall that already succeeded. It stamps access metadata and nominates reinforcement pairs, both
scoped to what the pack actually emitted onto the wire rather than to the wider co-activated or
admission-passed set. It also appends a `pack_emitted` row naming both populations (the emitted
ids and, separately, everything fusion, resonance and the intention pass retrieved) to the usage
stream ahead of the graph writes that follow, since a pack is emitted whether or not the access
bump behind it lands. A time-travel read does none of them, since asking what the substrate held
last month is a question rather than a use.

The usage stream is the salience half of the record, in SQLite's insert-only `usage_events`
table beside the experience archive. The archive holds what the substrate was told, so a replay
from it rebuilds every fact and knows nothing about what mattered: access stamps, edge weights
and sweep moments live only in the graph. Seven kinds close that gap, appended as they happen
and read back oldest first: `recall_access` and `pack_emitted` from the listener above,
`reinforcement_applied` when the flush's graph write lands rather than when a signal is
enqueued, and `decay_sweep` with the scan parameters a sweep is a pure function of. A caller
states three more. `delivery_acknowledged` (a caller says a pack reached it, which server-side
assembly alone cannot establish) and `memory_used` (a caller says it acted on named memories, a
self-report by construction) both arrive in the reflection tool's `feedback` block.
`memory_confirmed` (a confirmer and a reference, with evidence required rather than optional, the
same confirmation record a pack's standing renders) arrives under `provenance.confirmations`
instead, because it is evidence about a memory rather than a report about a pack.
`aion replay run` restores what the substrate knows; `aion replay usage` puts back what it
found worth knowing, on top.

## Maintenance path: the introspection loop

A third path, on the service's own clock rather than on a caller's request. `Introspector`
(`introspection/application/engine.ts`) starts with the service and stops before the driver
does, and one tick runs four phases: observe, decide, act, learn.

1. **Observe.** `observeHealth` assembles one `HealthSnapshot` from the surfaces `aion
   doctor` and `/health` already read: graph structure (node population, vector parity,
   orphan share, episodes with no session link), queue (depth per lane, oldest unclaimed,
   exhausted attempts, enrichment lag, the share of recent recalls that degraded on the recall
   model call, and the reinforcement rows the queue cap threw away), enrichment (episodes with
   no orchestrator ledger key), plasticity, proposals, entities (identities the deterministic
   tier-0 sweep could still absorb), redaction residue, the narrative-seal backlog, the eviction
   census, the batch lane (work owed, work a vendor holds, and how long the part a run can move
   has waited), generation health, and the per-operation effectiveness record tier 2 scores on. The
   recall-degradation share reads as unmeasured rather than as healthy until the first recall
   lands. Every collector is caught
   independently; one that throws names itself in `degraded` and costs its own metrics rather
   than the reading.
2. **Decide.** `decide` (`introspection/domain/decide.ts`) is pure: the same snapshot always
   produces the same answer, so a decision is arguable from the numbers. Tier is a property of
   the cycle rather than of the operation: an operation names the critical condition it repairs
   in `answers`, and it preempts the whole catalog unweighted on the cycles the snapshot meets
   that condition. Two conditions, each with a responder: episodes with no session link
   (`emergency_relationship_repair`), and vector parity under 0.8 measured over at least twenty
   expected vectors (`vector_backfill`), since parity says nothing about a substrate smaller than
   that. `orphan_cleanup` answers no condition: disconnection is a diagnostic scored on demand in
   tier 2, never a preemption. A graph collector that failed reports no critical condition at
   all. Preemption is not open-ended. Past a grace of three
   resolved runs, an operation keeps preempting only while it is still moving the metric it
   declared, because a condition can stand for weeks and nothing else may wait that long. Tier
   2 scores the rest by each operation's own `relevance`, halved for an operation whose runs
   have stopped improving anything and multiplied by how many cycles it has been passed over.
   It selects the highest above `AION_MAINTENANCE_URGENCY_THRESHOLD`. Tier 3 is the
   model-guided seam: on by default (`AION_MAINTENANCE_TIER3`), and acting by default because
   `AION_MAINTENANCE_TIER3_MODE` ships `act`. `AION_MAINTENANCE_TIER3=false` is the kill
   switch, `propose` is the kill switch inside it; on any tick that reaches tier 3, the standing
   cost is one advisor call, which reasons before it answers under
   `AION_ANTHROPIC_THINKING_BUDGET_TOKENS` or `AION_OPENAI_REASONING_EFFORT`.

   Ordinary reinforcement no longer waits on this loop. A quarter-hour bucket filled by whatever
   scores highest across thirty-two operations is the wrong clock for a queue that fills on every
   recall, so the drain has its own five-second cadence and `reinforcement_flush` stays in the
   catalog as the manual and maintenance route into the same owner. Measured against the real
   loop on a twelve-burst, six-hundred-signal offered load (`plasticity/application/drain.int.test.ts`,
   2026-09-13): the loop selects the flush on its first cycle, which is up to fifteen minutes of
   wall clock away, and the dedicated cadence drains the same load in 104ms. The cadence also
   changes learning, deliberately: `aggregateWindow` folds one claimed batch into one bounded step
   per pair, so the same signal stream split across more windows applies more steps. The asymptote
   keeps the difference small and it is a real difference, and no bounded drain empties a queue
   that arrival outruns: the queue's rolling cap and its dropped counter are what say when that
   happens.

   One call and one gate. The advisor sees the reading, the candidate table, each operation's
   record, and one line per recent resolved run saying what happened. Its confidence is
   multiplied by that operation's own effectiveness and has to clear
   `AION_MAINTENANCE_TIER3_ACCEPTANCE_FLOOR`, so a confident recommendation for an operation
   whose runs have stopped moving their metric is kept as a recommendation. An operation nothing
   has scored reads at a neutral 0.5 prior rather than at zero, since a model-chosen run is one
   of the ways an operation earns a record. Two operations are denied outright and no others:
   `episode_evict`, the one hard delete, and `redaction_residue_purge`, which overwrites stored
   text in place. Everything else in the catalog is selectable, because a write the substrate can
   reverse is a write its own record can judge.

   A degraded collector does not stop the consultation. An operation whose demand came from the
   collector that failed returns zero relevance and is refused at the gate; the rest of the
   reading is still evidence, and refusing the whole cycle over one broken collector stopped the
   loop noticing anything else.
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
   reads, and the same counts weight the strategic tier's acceptance. An operation with no
   metric in the snapshot records `unmeasured` instead: the run is on its record, and its
   effectiveness reads as unmeasured rather than as a number, which step 2's weight and the
   preemption grace both leave alone. Twenty-two of the thirty-two operations declare no metric,
   so the strategic tier weights those on the half of the record a metric is not needed to read:
   the share of their runs that did not fail (`executionWeight`, `introspection/domain/tier3.ts`).
   A run that threw did not do the work whatever the work was worth, and five recorded throws are
   not a cold start. The weight cannot rise past the neutral prior on unmeasured runs, because an
   unmeasured success is unknown rather than good, and it climbs back toward that prior as clean
   runs accumulate, so a transient fault costs an operation cycles rather than vetoing it.
   Every run's wall time is recorded too, whatever it did,
   which makes the cheapest way to answer a reading a fact. Each verdict also writes one
   sentence saying what happened, built from the run's own numbers and never from a model, and
   the newest few of those reach the advisor's prompt. A ratio says how often an operation
   helped; the sentence says that a run drained nine rows and the depth was the same an hour
   later, which is the reading a recommendation can be argued against.

The catalog is one ordered list (`introspection/application/catalog.ts`), which is the only
place an operation joins maintenance. Thirty-two are registered, in eleven groups: substrate
hygiene (`vector_backfill`, `reconcile_reenqueue`, `batch_settlement`, `dead_letter`,
`redaction_residue_purge`), plasticity (`reinforcement_flush`, `memory_decay`, `edge_prune`,
`identifier_decay`), the chunk lifecycle (`narrative_seal`), the raw projection's end
(`episode_evict`), content maintenance (`narrative_cleanup`, `narrative_regrounding`,
`retro_judgment_sweep`, `description_freshness`, `intention_upkeep`, `curiosity`), compression
(`narrative_rollup_day`, `narrative_rollup_week`, `claim_consolidation`), topology
(`emergency_relationship_repair`, `orphan_cleanup`, `community_refresh`, `symbiosis_bridge`,
`structural_discovery`), entity and claim-merge policy (`merge_auto`, `claim_dedup`,
`merge_decision_reconcile`), the self-probe (`recall_probe`), the proposal queues
(`proposal_resolution`, `proposal_hygiene`), and the confirmation signal's two-store seam
(`confirmation_signal_completion`). List order is documentation: selection is by tier and
urgency, and ties break on waiting time and then on name.

Ten declare a `measure`, the health-snapshot number their run is scored on moving. The
other twenty-two record `unmeasured` instead. Seventeen of those wait on a gauge the snapshot
does not carry yet; the last five decline one on purpose. `batch_settlement` would be scored on
the lane's backlog, which weights the pump down for the vendor's turnaround. `proposal_resolution` moves the
open-proposal count, and scoring it on lowering that would reward an applied correction and a
dismissed one alike, which rewards emptying the queue rather than deciding it. `recall_probe`
produces numbers instead of moving them, so a run that scored a miss did its job exactly as
well as one that scored a hit. `narrative_seal` and `episode_evict` refuse for the same reason
one step further: each would be scored on lowering its own backlog, which credits a chunk
blocked the same as one published, and rewards a destructive pass for removing more of the
resident population.

One of the thirty-two adds to memory rather than tidying it. `curiosity` files a question
about an entity the substrate keeps meeting and cannot describe, as a Goal marked `origin_kind:
substrate` keyed to that entity, which the entity itself brings back through the intention
triggers above. It writes through reflection intake like any other experience, which is also
how the substrate records its own lifecycle events, so both are recallable, replayable and
forgettable by the ordinary commands. `docs/operations.md` carries both and their kill
switches.

One repair sits beside the catalog and is deliberately not in it. `entity_unmerge` splits an
absorbed identity back out of the entity it was merged into. A bad merge is not measurable
from inside the graph (a correct merge and a wrong one have the same shape), so a person
names the merge to reverse; `aion unmerge ls|apply` is where they name it.

`aion stats` renders the loop's own record: the cycle count, and per operation the runs, the
improved/unchanged/failed/unmeasured split, the typical cost of a run, and the last window's
outcome from the ledger.
`aion maintain ls` lists the catalog; `aion maintain run <name>` forces one operation now,
bypassing the relevance score and the bucket claim and nothing else. The escape hatch exists
because one operation's subject is not proportional: thirteen leaking nodes out of two
thousand is a small share to a scoring function and an incident to a person.

**Two operations the design names and this does not register.** `entity_consolidation` is a
placeholder in the design itself and waits on a measure of entity fragmentation the snapshot
does not take. `temporal_hygiene` has no trigger: nothing in the snapshot counts a
validity-period violation, and an operation with no gauge cannot be scored or starved. The
other two the design named are covered under different names: `edge_prune` ages edge weight
down against staleness, and `structural_discovery` writes association edges to
under-connected identities directly.

**Who chooses the bridge.** Which two neighbourhoods to consider is structure, scored on
coherence, size balance, overlap and isolation. What relation runs between them, and which two
members carry it, is inference. The model is handed a profile of each community, members and
their text included, and answers with the two endpoints, what each contributes, the summary, the
rationale, the statements it rests on, and a compatibility score, or it declines.

Its answer decides the run. A decline writes nothing. A compatibility under
`AION_MAINTENANCE_BRIDGE_MIN_COMPATIBILITY` writes nothing. Neither falls back, because falling
back would make the judgment a suggestion and the deterministic pair the real answer. The
deterministic pair is what happens when no answer arrives at all: unavailable, timed out, or
unreadable. It picks the closest cross-community pair by content vector and says so in the text,
and the bridge records which path wrote it.

The endpoints are often not the closest pair, which is the point. The cosine measures how alike
two texts read; a cause in one neighbourhood and its consequence in the other read nothing alike
and are the relation worth storing. Measured 2026-09-13 against claude-haiku-4-5 on two
hand-built clusters, the model anchored an incident bridge on the pool exhaustion and the
checkout outage (cosine 0.000) over the two near-identical release-note members the cosine rule
picks. The cosine between whatever pair is chosen is still recorded on the node, so how far apart
the vectors put them stays visible. The bridge's edges are weighted by the author's own reading
instead: the model's compatibility, or the cosine on the deterministic path.

Every bridge carries the premises it was inferred from, the role each endpoint plays, and a flag
saying it is an inference. A reader that cannot tell a proposed relation from a recorded one
cannot correct either.

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

`supersedeSubjectFamily(driver, { claimId, newId })` is the middle blade
(`infrastructure/graph/subject-family.ts`), and the default an applied proposal takes. It
closes the judged claim and only those siblings of the same episode that name one of its
subjects, with provenance `supersession_subject_propagation`. A subject is an entity that
episode mentioned whose stored fold appears inside the claim's. A definition of a neighbouring
term and a record of a benchmark stay open, which is what separates it from closing the
episode. The same call retires the description of a subject entity whose gloss names another
subject of the closed claim. An entity is never closed, since one outlives every episode that
named it, but a frozen sentence restating a claim that just closed is cleared so recall stops
serving it as a current fact.

What decides that a close should happen is two model calls, not one. The supersession stage
judges each pair (`reflection/application/stages/supersession.ts`),
and under the shipped `AION_SUPERSEDE_MODE=unanimous` every affirmative goes to a second call
that argues the other side on the same evidence and never sees the first one's reasoning
(`supersession-review.ts`). It checks whether the older claim is actually made false, since an
opinion, a wider scope, and a different attribute of one subject all survive. It also checks
whether the newer claim is coherent at all, since a garbled extraction can win a same-subject
comparison while asserting nothing. Only a unanimous pair closes, through the same
`applySupersessionProposal` path a review takes, stamped `supersession_unanimous_auto`. A veto
becomes a proposal row carrying the reason, which `proposal_resolution` decides again on wider
evidence. The stage reports six outcomes rather than two.
`closed`, `vetoed` and `proposed` are the ordinary three. `stale` is a judgment whose losing side
had already lost currency, so it closed nothing and its row is resolved rather than left open
for a correction that already happened. `withheld` is a judgment whose evidence moved
between the answer and the write, so the pair goes back to being owed. `already_decided` is a
pair carrying a person's ruling, which no mode may reopen and which writes no counter at all.
Confidence was the earlier gate and is not one: the judge answers 0.95 to every affirmative it
makes, and a threshold over one value gates nothing.

`unsupersedeNode(driver, { id })` (`infrastructure/graph/unsupersede.ts`) is the inverse, and
`aion unsupersede` drives it. It closes the `SUPERSEDES` edge in system time rather than
removing it, stamps `reopened_at` on it, and drops the two stamps that closed the node. A
reopened claim then reads as current, `aion why` shows the close and the reopen both, and a
knowledge-time read pinned before the reopen still reports the supersession the substrate held
then. It works on a close from any mode, since every close writes the same stamps.

Four read modes, all built from one composable fragment
(`infrastructure/graph/read-modes.ts`) so every seed strategy and the traversal share one
definition of currency:

- **`withCurrency()`**: the default. No time is pinned; a row is included whenever
  `forgotten_at IS NULL`. Every returned item still carries a `currency` label (`current`,
  `superseded`, or `expired`, judged against now) and, when superseded, a
  `superseded_by { id, at }` pointer. `expired` marks a reading aged past the
  `valid_horizon` it was written with; down-ranked, never dropped, and on by default
  (`AION_TEMPORAL_EXPIRY_ANNOTATION`). This is currency-aware, not currency-filtered:
  superseded and expired knowledge are still eligible, just annotated.
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
a retry. Retried or duplicated *content* writes (episodes, turns, edges) are unaffected;
that guarantee holds through `MERGE`.

## Graph schema surface

**Node labels.** Twenty primary labels, pinned in `infrastructure/graph/labels.ts`:
`Session`, `Episode`, `Turn`, `Entity`, `Member`, `Workspace`, `Substrate`, `Narrative`,
`Bridge`, `Synthesis`, `Preference`, and the nine cognitive types (`Goal`, `Plan`, `Decision`,
`Insight`, `Concept`, `Context`, `Event`, `Pattern`, `Trend`). `Synthesis` is a conclusion drawn
across memories and `Preference` is a way of working read off how somebody worked; both carry
`inferred` on the node and serve under their own standing (`concluded`, `inferred`), so nothing
renders either as a sentence somebody said. Every node also carries `AionNode`, which gives
type-agnostic id lookups (both edge endpoints, the supersession close) an index to seek.
Neo4j has no label-free property index, so without it those lookups would scan the whole
graph. Every content-bearing label carries `Memory` as well, which is everything above
except `Session` and the three backbone nodes. A Neo4j vector index cannot span a label
union, so `Memory` is the only mechanism that lets one vector index cover more than one
node type. The backbone nodes (`Member`, `Workspace`, `Substrate`) stay out of `Memory` (they
are connectivity, not content) and carry `Entity` instead, so the `name_norm` uniqueness
constraint and the entity-resolution seed strategy both apply to them. `Substrate` is the
substrate's own identity, one node named `Aion` for the life of the substrate, linked
`WITHIN_WORKSPACE` to the global workspace. It is not an agent identity: a session on any
harness or model continues the one identity, and which harness produced an episode is
provenance the episode carries. It is also what one session links `INITIATED_BY`: every other
Session points at the Member, and the standing `aion-system` session the lifecycle events chain
in points here instead, because nobody typed them.

**Indexes and constraints** (`infrastructure/graph/migrations.ts`, one declaration replayed on
every `aion init`):

- Uniqueness constraints on `AionNode.id`, and on `.id` for every primary label except
  `Entity`, which takes `entity_name_unique` on `name_norm` alone instead: `Session`,
  `Episode`, `Turn`, `Member`, `Workspace`, `Substrate`, `Narrative`, `Bridge`, `Synthesis`,
  `Preference`, and the nine cognitive types. One name is one identity whatever type the extractor picked for it, and
  `type` follows counted readings as an ordinary property.
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
- One range index, `claim_subject_aspect_idx` on `Memory(subject_entity_id, aspect_norm)`: the
  seek behind the subject-keyed claim lookup, which asks on every fact-bearing write which open
  claim already asserts the same attribute of the same subject.
- One fulltext index, `memory_content_fts`, over `Episode|Turn|Entity|Narrative` plus the
  nine cognitive labels, `ON EACH [summary, text, name]`, the target of the `bm25` seed
  strategy. `Bridge` is the one `Memory` label it leaves out.
- One more uniqueness constraint, on the publication guard's id (`publication-guard.ts`). Only
  the constraint is declared here; the guard node itself is created under the substrate's
  bootstrap marker, so a guard that goes missing after init is reported rather than silently
  replaced.

**Edge merge policy** (`infrastructure/graph/edges.ts`). Every relationship write goes
through one `MERGE`, matched on endpoint ids resolved through `AionNode`: on create it
sets strength, confidence, signal and provenance lists, and a count; on match it takes
`max(strength)`, `max(confidence)`, set-union on signals, set-union on provenance,
`sum(count)`, and refreshes `updated_at` while leaving `created_at` alone. The six
undirected types (`SIMILAR`, `CO_OCCURS`, `RELATED_TO`, `ANALOGOUS_TO`, `CONTRADICTS`,
`ALTERNATIVE_TO`) normalize their endpoint order before the merge, so writing an edge from node
A to node B and later from B to A lands on one edge, not two. `CONTRADICTS` is undirected because
tension is mutual: two claims in tension state the same thing from either end, and
`ALTERNATIVE_TO` for the same reason: two conclusions the same premises support are read together
or the reader is handed a certainty the substrate does not hold.

`CO_OCCURS` is the one type whose write is a step rather than a claim (`bounded_step`), and what
one step is worth is the episode's single observation divided by the pairs it minted, floored at
`AION_HEBBIAN_WEIGHT_FLOOR` (`coOccurrenceBirthStrength`). A two-entity episode's only pair is
born at full strength; from five entities up the share falls under the floor and every birth
plateaus there, so width stops telling pairs apart and repetition does it instead: a pair two
dense episodes both name climbs 0.1, 0.19, 0.271, and a pair named once waits for decay. Nothing
is capped, gated or deleted; traversal already scales propagation by an edge's stored strength
(`recall/domain/activation.ts`), which is what makes the weighting reach recall at all.
Twenty-three directed types cover containment
(`PARTICIPATES_IN`), temporal chaining (`FOLLOWS`, `PRECEDES`), provenance
(`DERIVES_FROM`, `EVIDENCES`, `EXTRACTED_FROM`, `CORRECTS`), the backbone (`HAS_MEMBER`,
`HAS_WORKSPACE`), and this build's bitemporal extension, `SUPERSEDES`. `CORRECTS` is what a
caller states outright against a node it names: a record of the claim, never a close, since
only the supersession judge writes `SUPERSEDES`.
