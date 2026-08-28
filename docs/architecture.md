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
from `recall/`, `reflection/`, `session/`, or `redaction/` — it has no notion of episodes,
cues, or memory packs, only nodes, edges, and rows.

- **`infrastructure/`** — `graph/` (every Cypher statement in the workspace), `sqlite/`
  (the reflection queue, last-pack cache, ops ledger, claim locking), `providers/` (the
  Ollama client and its circuit breaker), `config/` (schema, defaults, the `AION_*`
  registry, the loader), `logging/`.
- **`recall/domain/`** — `activation.ts` (spreading activation over adjacency),
  `fusion.ts` (RRF/MMR ranking and the currency policy), `pack.ts` (MemoryPack assembly).
- **`recall/application/`** — `cues.ts` (cue extraction and its cache), `seeds.ts` (the
  four seed strategies' scoring and merge), `candidates.ts` (seeds plus activation into
  ranked lists), `recall.ts` (the pipeline), `side-effects.ts` (post-recall listeners).
- **`reflection/domain/`** — `content.ts`: episode/turn shaping and content hashing.
- **`reflection/application/`** — `intake.ts` (the write path), `dispatch.ts` (the
  event emitter intake signals; nothing subscribes to it yet — see Status in the README).
- **`redaction/`** — `entropy.ts`, `rules.ts`, `deep-walk.ts`, `redact.ts`,
  `fingerprint.ts`. Deterministic and rule-based by design: this is the one place inference
  is deliberately not used, because a credential leak cannot wait on a model's judgment.
- **`session/`** — `session-manager.ts`: identity-to-session-id resolution, cached per
  process, backed by `infrastructure/graph/sessions.ts`.

One edge crosses contexts: `recall/domain/fusion.ts` imports `hashContent` from
`reflection/domain/content.ts` to dedupe fused items by content hash before packaging,
the same hash reflection uses as its episode dedupe key. It is the sole domain-to-domain
import in the codebase.

## Write path: reflection intake

`handleReflection` (`reflection/application/intake.ts`) runs these steps in order:

1. Parse the payload against `ReflectionInputSchema`; reject anything that fails.
2. Split off `session_id` — it is routing, not content, so it never reaches the hash or
   the redaction walk.
3. Redact the remaining payload (`redactPayload`): every string field in `turns`,
   `tool_executions`, and `observations` is walked and scanned against the rule set and an
   entropy threshold; matches are stripped and logged, never stored.
4. Resolve the session (`ensureSession`), reusing a cached identity-to-session-id mapping
   when one exists.
5. Shape the payload into one episode and its turns (`prepareEpisode`), each carrying a
   sha256 content hash over a canonically key-sorted JSON encoding.
6. Check for a duplicate by `(sessionId, contentHash)` outside any transaction. If found,
   skip straight to step 8 — no embedding call, no write.
7. Otherwise embed the episode text and every turn's text in one batched Ollama call, then
   open a single write transaction: lock the session node (which serializes intake for
   that session and closes the race where two concurrent identical payloads both miss the
   duplicate check), re-check the duplicate under the lock, write the stamped `Episode`
   node and each stamped `Turn` node, and link `Turn -[:PARTICIPATES_IN]-> Episode`,
   `Episode -[:PARTICIPATES_IN]-> Session`, and `Turn -[:FOLLOWS]-> <previous Turn>`.
8. Find or create a pending `integrate` job in the SQLite reflection queue, keyed by
   episode id. The check is against the queue, not assumed from step 7's outcome, so a
   crash between the episode commit and the enqueue self-heals on the next identical push.
9. If a new job was enqueued, signal `ReflectionDispatch` so a subscribed worker can start
   immediately; the SQLite row is what a restart replays from regardless.
10. Return `{ episode_id, queued: true }`.

No generation call happens after step 7. Extraction — turning an episode into entities,
associations, and narratives — is a separate pipeline that subscribes to the dispatch
signal; it is P3 work and does not exist yet, so today's `integrate` jobs are written and
never claimed.

## Read path: recall

`handleRecall` (`recall/application/recall.ts`) runs these stages, each timed
independently for the pack's `stage_timings_ms`:

1. **Cues.** One generation call (the cue model) turns the query, and optionally a summary
   and recent turns, into weighted cues: query text weighs 3x, summary 2x, recent-turn
   text 1x. If the call times out, errors, or returns something unparseable, recall falls
   back to a raw-query/raw-summary cue instead of failing, and the pack records that
   degradation.
2. **Embed.** Every cue is embedded in one batched call. A failure here costs recall its
   vector leg only — BM25 and exact entity resolution still run on cue text.
3. **Seeds.** Four strategies run together: `vector` (nearest neighbors in the two content
   vector indexes), `bm25` (the fulltext index), `entity_resolution` (exact and
   fuzzy name match against `Entity` nodes), and `recency` (a `tx_from`-ordered fallback
   for a substrate with no access history yet). Candidates merge by node id; a node found
   by more than one strategy keeps every strategy that found it.
4. **Activation.** Every seed enters at full activation. Spreading runs in TypeScript over
   batched adjacency reads — the graph answers one question per frontier iteration, and
   everything else (per-relationship-type weighting, decay, the minimum-activation floor,
   the max-nodes-visited cap) happens in process, where it is unit-testable without a
   server.
5. **Fusion.** Seed and activated candidates are hydrated, then fused: weighted Reciprocal
   Rank Fusion across the vector/bm25/graph_traversal legs by default (`rrf`, k=60), or
   MMR reranking when `AION_SEARCH_RERANKER=mmr`. Items below `AION_MIN_RELEVANCE` are
   dropped even if they rank; duplicates collapse by content hash, keeping the
   higher-ranked instance.
6. **Pack assembly.** Fused items route to a bucket by node label — `Episode`/`Turn` to
   `episodes`, `Entity` to `facts` — are capped per bucket, trimmed to the token budget,
   and rendered into the pack's text block. `narratives`, `preferences`, and `resonant`
   have no producer yet (P3 and P4 work), so they are structurally absent rather than
   empty: a P2 pack can never contain them.

The pack is saved to SQLite's `last_pack` table (what `aion last` renders) and returned. A
registered listener — access-tracking, and eventually Hebbian reinforcement — fires
afterward and is never awaited, so a listener failure cannot fail a recall that already
succeeded.

## Bitemporal model

Every node carries three time concepts, all set at write time and never rewritten except
by `supersede`:

- **`occurred_at`** — when the experience happened. Defaults to the write-time clock;
  callers may backdate individual turns.
- **`valid_from` / `valid_until`** — world time: the interval during which the fact was
  true. `valid_until` absent means still current.
- **`tx_from` / `tx_until`** — system time: the interval during which the substrate held
  this belief. `tx_until` absent means still held.
- **`forgotten_at`** — the one true suppression, written by the not-yet-built `aion
  forget`. Default recall hides a forgotten row; `as_of`/`knew_at` still surface it.

`supersede(driver, { oldId, newId })` closes both intervals on the old node with a
`coalesce` (so a repeated call is a no-op) and links
`(new)-[:SUPERSEDES]->(old)` in the same transaction — a closed node with no lineage edge
is not a state the substrate can reach.

Four read modes, all built from one composable fragment
(`infrastructure/graph/read-modes.ts`) so every seed strategy and the traversal share one
definition of currency:

- **`withCurrency()`** — the default. No time is pinned; a row is included whenever
  `forgotten_at IS NULL`. Every returned item still carries a `currency` label (`current`
  or `superseded`, judged against now) and, when superseded, a `superseded_by { id, at }`
  pointer. This is currency-aware, not currency-filtered: superseded knowledge is still
  eligible, just annotated.
- **`asOf(validAt)`** — a world-time slice: rows whose valid interval covers `validAt`.
- **`knewAt(knownAt)`** — a system-time slice: rows whose transaction interval covers
  `knownAt`. Lineage itself is filtered to supersessions recorded by `knownAt`, so a
  knowledge-time read cannot report a correction the substrate had not made yet.
- **`bitemporalAt(validAt, knownAt)`** — both predicates at once: what the substrate
  believed at `knownAt` about what was true at `validAt`.

One write is exempt from strict idempotency by design: `access-tracking.ts` bumps
`last_accessed` and increments `access_count` on every node a recall surfaces, and running
it twice for the same node doubles the count on purpose — it is a real access, not a
retry, that should double it. Retried or duplicated *content* writes (episodes, turns,
edges) are unaffected; that guarantee holds through `MERGE`.

## Graph schema surface

**Node labels.** `Session`, `Episode`, `Turn`, `Entity`, `Member`, `Workspace` are the
primary labels. Every node also carries `AionNode`, which is what gives type-agnostic id
lookups (both edge endpoints, the supersession close) an index to seek — Neo4j has no
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
- One fulltext index, `content_fts`, `FOR (n:Episode|Turn|Entity) ON [summary, text,
  name]` — the target of the `bm25` seed strategy.

**Edge merge policy** (`infrastructure/graph/edges.ts`). Every relationship write goes
through one `MERGE`, matched on endpoint ids resolved through `AionNode`: on create it
sets strength, confidence, signal and provenance lists, and a count; on match it takes
`max(strength)`, `max(confidence)`, set-union on signals, set-union on provenance,
`sum(count)`, and refreshes `updated_at` while leaving `created_at` alone. Undirected
relationship types (`SIMILAR`, `CO_OCCURS`, `RELATED_TO`, `ANALOGOUS_TO`) normalize their
endpoint order before the merge, so writing A→B and later B→A lands on one edge, not two.
Twenty-one directed types cover containment (`PARTICIPATES_IN`), temporal chaining
(`FOLLOWS`, `PRECEDES`), provenance (`DERIVES_FROM`, `EVIDENCES`, `EXTRACTED_FROM`), the
backbone (`HAS_MEMBER`, `HAS_WORKSPACE`), and this build's bitemporal extension,
`SUPERSEDES`.
