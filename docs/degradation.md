# Degradation modes

## Principle

Degradation means doing less inference, never switching to heuristics: a failed recall model
call serves the retrieval ranking it was about to judge, with no substitute rule in its place
(PRD §6.1). Every degraded
answer names itself in `metadata.degraded`, a list of `{stage, reason}` entries, one per
rung that fired. An empty pack beats a noisy one: a floor nothing clears, or a substrate
with nothing relevant, returns empty rather than padded with weak matches.

## The ladder

Eleven modes. Each names the evidence behind it. Four were induced live against a throwaway
Neo4j plus host Ollama (both Ollama outages, both Neo4j outages). Three are covered by the
unit suite, which is enough because they need only process inputs (the recall model call,
context resonance, intention triggers). One is read off the MCP SDK's own behavior (client
disconnect), and one is traced through the startup path without a probe (SQLite unwritable).
The two remote modes are traced through the provider and the routing rule, both under the
unit suite, and neither has been induced against the live API. Numbers are wall-clock from
those runs, not guarantees.

### The recall model call fails (timeout, model error, unusable answer)

**Trigger.** Recall's one `generate` call (PRD §10's hot-path rule) times out, errors, or
answers with something unusable. Under the default `AION_RECALL_MODE=assess` that call is the
assessment. Under `cues` it is cue extraction. `raw` makes no call and has no rung here.

**What happens.** Both calls run under an `AbortController` keyed to `AION_CUE_BUDGET_MS`. An
abort is `timeout`, a missing key or a spent ceiling is `unavailable`, and any other error is
`model_error`.

- `assess`: `assessCandidates` (`packages/core/src/recall/application/assessment.ts`). An
  answer that fails the schema, or whose numbers name no candidate at all, is `invalid_output`.
  Retrieval already ran on the caller's own query, so a failure costs only the judgment:
  `assessedServing` serves the ranking assembly the path built anyway. A number that names no
  candidate in an otherwise usable answer is dropped and counted, and is not a failure.
- `cues`: `extractCues` (`packages/core/src/recall/application/cues.ts`). A response that
  fails `CueModelOutputSchema` is `invalid_output`. `degradedResult` builds cues from the
  caller's own query and summary text verbatim (query at weight 3, summary at weight 1). Only
  a successful extraction is cached, so a degraded call never poisons a later one for the same
  input.

A selection whose evidence moved before it could be recorded is dropped too, and the ranking
serves. That is not a degradation, because the call worked: `metadata.assessment.outcome`
reads `discarded`.

**What the caller sees.** A normal `MemoryPack` with one entry in `metadata.degraded`:
`{stage: "assessment", reason}` under `assess`, `{stage: "cues", reason}` under `cues`. Under
`assess`, `metadata.assessment.outcome` reads `fallback` with nothing selected, and the
rendered note says `degraded memory assessment, so this is the retrieval ranking (<reason>)`.

**Diagnose.** Live, the service logs `recall assessment failed` with the reason and route, or
`recall assessment answer was unusable`. Under `cues` it logs `cue extraction degraded`.
`aion last` prints `degraded  assessment: <reason>` and an `assessed  fallback` line above the
pack. Across calls, `aion status`'s `recall` line and `aion doctor` print the share of recent
recalls that degraded on the recall model call, and read `no recalls yet` until the first one
lands. The introspection loop reads the same number off the health snapshot.

**Recovers.** Automatically, next call. No state to reset.

Measured live on 2026-09-29: 119 assessed recalls on GPT-6 Luna took p50 1.6s, p95 2.6s and
at most 4.4s against the 8s budget, and none failed. The failure paths are verified by the
unit suite, not live-induced: `assessment.test.ts` covers each failure reason, unusable
numbers and the fallback serving, and `cues.test.ts` covers the uncached degraded result,
both `invalid_output` shapes and the timeout (68 tests across the two files).

### Full Ollama outage: recall

**Trigger.** `AION_OLLAMA_URL` points at nothing reachable. The embedding call fails. The
recall model call is unaffected: it runs remotely.

**What happens.** `embedCues` (`packages/core/src/recall/application/stage-reads.ts`) tries
to embed the query's cues, fails, and returns them without vectors, logging `cue embedding
failed`. `handleRecall` collects every rung that fired, in stage order, into one list. With
no vectors, BM25, entity resolution, recency, and graph traversal carry the recall alone, and
the assessment judges what they found.

**What the caller sees.** A `MemoryPack` with `metadata.degraded` holding an `embed` entry.
A dead embedder and a failed model call are separate rungs and read separately, which is what
lets a caller tell "ranking is thinner" from "the model leg is down". With no key as well,
both entries are present: `[{stage: "embed", reason: "model_error"}, {stage: "assessment",
reason: "unavailable"}]`.

**Diagnose.** `aion doctor`'s `ollama-round-trip` check. Live, both log lines above fire
in the same request. `aion last` prints two `degraded` lines.

**Recovers.** Automatically, next call, once Ollama answers again.

### Full Ollama outage: reflection

**Trigger.** Same outage, on the write path.

**What happens.** Nothing at all happens to the intake call. Intake makes no embedding call:
`projectEpisodeInTransaction` commits the `Episode`, its `Turn` nodes and every backbone edge
with no `content_vec` property, and the acknowledgment writes three queue rows, one of them the
`attach_vectors` job that owes the embedding
(`reflection/application/intake-queue.ts`). A `:Memory` node without `content_vec` is itself the
pending marker; there is no flag property to keep in sync with it
(`packages/core/src/infrastructure/graph/pending-vectors.ts`).

The outage lands on that queue row instead. The worker claims it, the embed call fails, and the
job goes back on its ordinary backoff with its attempts counted, the same as any other failure.

**What the caller sees.** The ordinary ack, `{episode_id, queued: true}`, and no wait on the
embedding service at all. `ReflectionNotStoredError` has no `embed` stage: the only way intake
can refuse is an unreachable graph.

Until the row runs, the episode is reachable by BM25, entity resolution, recency and traversal,
and invisible to vector search, the same shape as the recall-side outage above and for the same
reason.

**Diagnose.** `aion doctor`'s `ollama-round-trip` check. `aion queue ls` shows the
`attach_vectors` rows and their last error. `findPendingVectorNodes(driver, limit)` returns the
outstanding set directly.

**Recovers.** Automatically, once Ollama answers. Three paths run the same operation: the queued
job for one source, the reflection worker's startup drain over the whole backlog, and the
`vector_backfill` maintenance operation. Re-running any of them over already-vectorized nodes is
a no-op, so a partial drain resumes.

Verified against a throwaway Neo4j
(`reflection/application/intake-vectors.int.test.ts`): the episode, both turns,
`PARTICIPATES_IN` and the turn `FOLLOWS` chain all present the moment the call returns, all three
queue rows present, the enqueue callback fired, and `content_vec` absent on all three nodes.
`attachSourceVectors` against live Ollama then filled all three at the configured dimension
(1024, `snowflake-arctic-embed2`), and a second run found nothing left to do.

### Hosted provider outage

**Trigger.** The selected provider's key is set, so both generation roles route to its model
(`gpt-6-luna` under `AION_GENERATION_PROVIDER=openai`, `claude-haiku-4-5` under `anthropic`),
and the API answers 429, 5xx, or nothing at all: a rate limit, a regional outage, an expired
key.

**What happens.** Three attempts, then the breaker. Both providers share one retry rule
(`packages/core/src/infrastructure/providers/request-retry.ts`): a 429 or any 5xx is retried
up to `MAX_ATTEMPTS` (3). The wait is the `retry-after` header when the response carries one
and `attempt * 2000` ms when it does not, capped at 30s and cut short by the caller's own
signal. A 4xx that is not a 429 is not retried; it reaches the caller on the first answer.
Each provider sends every call through its own `CircuitBreaker` (`circuit-breaker.ts`), which
opens after 5 consecutive failures, fast-fails for 60s, then allows one trial call. A failed
trial re-opens it for another cooldown. An abort is not counted, so a stage deadline or a
shutdown never opens it. With the breaker open, a queued episode costs one call per cooldown
instead of three HTTP attempts each.

**What the caller sees.** On the write path, nothing: the episode is already stored and
queued before any generation runs, so the failure lands on the reflection job. The job fails.
The worker holds its claim through a backoff (5s base, doubling to a 300s cap) and retries up
to `AION_WORKER_MAX_ATTEMPTS` (5). A job that spends its attempts is left in the queue with its
last error, skipped by claiming, and becomes maintenance's `dead_letter` work
(`packages/core/src/reflection/application/worker.ts`). A session narrative fails the same
way: the narrative stage reports `failed` and its job retries on the same backoff. On the
read path, the recall model call degrades exactly as the first rung above describes, with
`reason: model_error`.

**Diagnose.** `aion stats`'s `generation by route` section prints calls, failure share and
mean duration per role and provider, from counters in the meta table that survive a restart.
A route nothing has called reads as `never called` rather than as a clean record. `aion
doctor`'s `ollama-round-trip` check and `aion status` print the routing line
(`cue=<provider>:<model> reflect=<provider>:<model>`), and `aion queue ls` shows the backlog
the outage is building.

**Recovers.** Automatically. The breaker's next trial call closes it, and the queue drains the
episodes that failed while it was open. Nothing is lost: every episode was stored before its
enrichment was attempted.

### No API key set

**Trigger.** The provider `AION_GENERATION_PROVIDER` selects has no key in `.env`:
`AION_ANTHROPIC_API_KEY` under `anthropic`, the default, or `AION_OPENAI_API_KEY` under `openai`.
There is no second route: the other provider's key does not stand in, and generation runs on the
selected provider or it waits.

**What happens.** Capture, embedding, the graph and the archive are untouched. Every `generate`
raises `GenerationUnavailableError` before it reaches the network
(`packages/core/src/infrastructure/providers/role-provider.ts`), and each caller answers it in
its own way. Recall serves the retrieval ranking it already built and records
`{stage: "assessment", reason: "unavailable"}` (`cues` under `AION_RECALL_MODE=cues`). The
batch lane sends nothing and leaves its work owed. The reflection worker releases the job **without
spending an attempt**: burning three attempts against a missing key would leave the queue holding
exhausted rows a later key could never revive.

Claiming then narrows rather than stops. The enrichment rows are all about to refuse for the same
reason, so the worker leaves them for one breaker cooldown (`AION_WORKER_BREAKER_COOLDOWN_MS`,
60s) and keeps claiming `attach_vectors` rows, which reach the local embedder and have no reason
to wait. After each cooldown it rechecks. A recheck spends no attempt and sends nothing, because
the unavailable route refuses it before any dispatch. A keyless substrate goes on vectoring
everything it captures.

**What the caller sees.** Ordinary answers with thinner ranking, and a queue that is not
draining. Nothing fails, and nothing runs on a smaller model instead.

**Diagnose.** One warn line at boot. `aion status` prints
`routing cue=queued(<provider>) reflect=queued(<provider>)` and a banner saying what still works.
`aion doctor` says `generation queued (AION_GENERATION_PROVIDER=<provider> needs <variable>)`
under `ollama-round-trip`, and `hooks-route` says captures are stored and queued. `aion queue ls`
shows the depth.

**Recovers.** Not automatically; nothing is broken. Put the key in `.env` and rerun `aion init`,
which restarts the service with it: routing is resolved once, at boot, and the queued work drains.
On a native install a key exported only in the shell does not count, because the launchd job
carries what `.env` records and nothing else.

### Neo4j down: recall

**Trigger.** The graph is unreachable mid-service: stopped, network-partitioned, or
otherwise not answering Bolt.

**What happens.** All five seed strategies (`vector`, `context_vector`, `bm25`,
`entity_resolution`, `recency`) issue their Cypher independently and in parallel; each
per-strategy failure is isolated by `settle()`, which contributes nothing rather than failing the call
(`packages/core/src/recall/application/seeds.ts`). `selectSeeds` also counts
attempts and rejections across every leg: when every query issued was rejected, it sets
`graphUnavailable: true` and logs `every seed query failed; treating the graph as
unavailable`. The recency leg always issues exactly one query, which
is what makes "nothing attempted" distinguishable from "everything rejected."
`handleRecall` turns that flag into `{stage: "graph", reason: "unavailable"}`. With zero
seeds, activation short-circuits and the pack assembles empty, so the assessment has nothing
to judge and makes no call.

**What the caller sees.** `metadata.degraded: [{stage: "graph", reason: "unavailable"}]`.
Before the fix, this same outage produced a normal-looking empty pack with **no** degradation
marker at all, byte-identical to a genuine "nothing matches" miss.

`rendered_text` now carries it too. `assemblePack` builds one plain line from the pack's
honesty signals (`honestyNote`, `packages/core/src/recall/domain/pack-notes.ts`) and renders
it directly under the heading, before any bucket:

```
# Memory

note: degraded graph reads (unavailable)

No memories matched this query.
```

The line names each degradation rung first. Then come a spread that stopped on the activation
budget (`metadata.truncated`), the calling session's un-enriched episode count
(`metadata.pending_enrichment`), the items it held back as repeats, own-session turns or
restatements, and the assessment's note, joined by `; `. It is absent on a pack with nothing
to say and present on an empty one, which is where a caller most needs it. Before the line existed, an agent
reading only the tool's text content, not `structuredContent.metadata`, could not tell an
outage from an honest miss, and one exercise angle lost a full baseline run to exactly that.

Re-verified live before the fix (`docker stop` on the harness Neo4j mid-service, then a
recall against a warm session): resolved in 16.6-17.6s across two runs (down from the pre-fix
62-66s, driven by the driver-timeout fix below) with `metadata.degraded` exactly
`[{"stage":"graph","reason":"unavailable"}]` and `rendered_text` then still the bare
empty-pack constant.

**Diagnose.** `aion doctor`'s `neo4j-bolt` check (`packages/cli/src/doctor.ts`), which
every graph-reading check declares as its `dependsOn` so a dead server is reported once
rather than as a timeout per check. Live, `selectSeeds`' error log line above names it
directly. `aion last` prints `degraded  graph: unavailable`.

**Recovers.** Automatically, no restart. `GraphConnection` holds one driver for the
process life (`packages/core/src/infrastructure/graph/connection.ts`); its pool
reconnects on its own once Neo4j answers again.

### Context resonance failure (graph error on the second pass)

**Trigger.** The second pass's graph reads (the context-vector fetch that builds the centroid,
or the search against the context index) fail after the first pass has already produced a
pack.

**What happens.** `resonate` (`packages/core/src/recall/application/resonance.ts`)
wraps both reads in one try/catch. A graph error there is caught, logged as `context resonance
failed; the pack keeps its first-pass answer`, and returns `{items: [],
skipped: 'unavailable'}` instead of propagating. `handleRecall` logs the skip reason on its own
`recall served` line (`logServed` in `recall-observers.ts`, field `resonanceSkipped`) but does
not add it to `degradations`, the list `metadata.degraded` is built from.

**What the caller sees.** The pack the first pass already assembled, with an empty `resonant`
bucket and no `metadata.degraded` entry naming resonance. This is the one rung on this ladder
that stays silent to the caller by design: the module comment calls swallowing the error the
right trade ("losing a whole recall to the associative stage would be the wrong trade every
time"). The cost is that the same empty resonant bucket looks identical whether the query had
no associative match or the graph read failed underneath it.

**Diagnose.** Not visible over MCP. Live, the service log's `resonanceSkipped: "unavailable"`
field on the `recall served` line is the only signal; `aion doctor`'s `neo4j-bolt` check
catches the underlying outage if it is still live when doctor runs.

**Recovers.** Automatically, next call, once the graph answers again. No state to reset.

Verified by the unit suite, not live-induced: `resonance.test.ts` fails the driver's
`executeQuery` call and asserts `skipped: 'unavailable'` with an empty item list and nothing
thrown past `resonate`.

### Intention trigger failure (graph error on the third pass)

**Trigger.** The bounded read of open intentions, or the hydration of the ones that fired,
fails after the query has already been answered.

**What happens.** `triggeredIntentions`
(`packages/core/src/recall/application/intentions.ts`) wraps both reads in one try/catch. A
graph error is caught, logged as `intention triggers failed; the pack keeps the answer it
has`, and returns `{items: [], skipped: 'unavailable'}` instead of propagating.
`handleRecall` logs the skip reason on its own `recall served` line (field
`intentionsSkipped`) and does not add it to `degradations`, the list `metadata.degraded` is
built from. This matters most on the empty-pack path: a recall that matched nothing still
returns its empty pack rather than failing on a stage that had nothing to add to it.

**What the caller sees.** The pack the query already produced, with no `intentions` bucket
and no `metadata.degraded` entry naming it. Silent to the caller by the same trade context
resonance makes: an intention is something the substrate volunteered, and losing a whole
recall over one would be the wrong trade every time. The cost is that an absent bucket
reads the same whether no intention was due or the read failed under it.

**Diagnose.** Not visible over MCP. Live, the `intentionsSkipped: "unavailable"` field on the
`recall served` line is the only signal; `aion doctor`'s `neo4j-bolt` check catches the
underlying outage if it is still live when doctor runs.

**Recovers.** Automatically, next call, once the graph answers again. No state to reset.

Verified by the unit suite, not live-induced: `intentions.test.ts` rejects the driver's
`executeQuery` call and asserts `skipped: 'unavailable'` with an empty item list and nothing
thrown past the stage.

Two other skips share that empty bucket and are not degradation. `AION_RECALL_INTENTIONS=false`
turns the stage off, which restores the pack exactly as it was before intentions had triggers.
A time-traveled read (`as_of` or `knew_at`) evaluates no trigger at all: asking what the
substrate held last month is a question about the past, and a trigger is the substrate acting
in the present. Both are reported as their own `intentionsSkipped` values.

### Neo4j down: reflection

**Trigger.** Same outage, on the write path, for a session whose identity has not been
resolved to a Session node yet (a fresh MCP connection, or the process's first reflection
for that identity). `SessionManager.ensureSession` caches resolved identities in memory
(`packages/core/src/session/session-manager.ts`); a cache hit needs no graph call and
is unaffected by the outage.

**What happens.** `storeExperience` calls `sessions.ensureSession`, which reaches
`ensureGraphSession` (`infrastructure/graph/sessions.ts`) and issues a write. It fails.
`isGraphUnavailable` (`infrastructure/graph/errors.ts`) recognizes the driver's
`ServiceUnavailable`/`SessionExpired` codes, or an unlabeled connection-acquisition timeout.
`storeExperience` then wraps it in `ReflectionNotStoredError('graph', err)`
(`reflection/application/experience-store.ts`) rather than letting the raw
`Neo4jError` escape. This is the one refusal the write path still makes: an unreachable
graph has nowhere to put the experience, so answering `queued: true` would lose it for good.

**What the caller sees.** An MCP `InternalError` (-32603):
`reflection not stored: the graph is unavailable (Neo4jError). Nothing was written and
nothing was queued; send this reflection again once the service is back.`

Re-verified live: a fresh client's reflection during the same outage window above failed
in 15.4-16.0s across two runs and returned exactly that message. Pre-fix, the same failure
took ~32s (the driver's default 30s transaction-retry budget) and, on a client with the MCP
SDK's default 60s request timeout, sometimes arrived as a bare `-32001 Request timed out`
with the server's real error lost entirely.

**Diagnose.** `aion doctor`'s `neo4j-bolt` check. Live, `tools.ts`'s `tool call failed`
log line carries the same message the caller received.

**Recovers.** Not automatically. Nothing was written or queued; resend once Neo4j is back.
The identity that failed is still unresolved, so the retry pays for `ensureSession` again,
this time against a healthy graph.

Re-verified against a live harness with a second driver pointed at a dead Bolt port
(`intake-vectors.int.test.ts`): the call raised `ReflectionNotStoredError` with stage
`graph`, and the healthy graph held zero `Episode` and zero `Turn` nodes for that session,
with no queue row and no enqueue callback.

### Driver timeouts, underneath both Neo4j modes

`GraphConnection`'s constructor used to take the neo4j-driver defaults as-is: 60s to
acquire a pooled connection, 30s of transaction retries. Both meet or exceed the MCP SDK
client's own 60s request timeout. That is why the pre-fix numbers above include a case where
the server's named error never reached the caller at all. The connection is now
constructed with `connectionTimeout: 5000`, `connectionAcquisitionTimeout: 10_000`,
`maxTransactionRetryTime: 10_000`
(`packages/core/src/infrastructure/graph/connection.ts`). A
healthy pool answers in microseconds, so these only bite during an outage, and the live
numbers above land inside them.

### SQLite unwritable at startup

**Trigger.** `AION_SQLITE_PATH`'s directory cannot be created: it already exists as a
regular file, or its parent does not exist and cannot be made.

**What happens.** `bootstrapService` constructs `SqliteStore` before anything else,
including the Neo4j health check (`packages/mcp/src/bootstrap.ts`).
`openSqliteHandle` calls `ensureDirectoryExists`, which is `mkdirSync(dirname(filePath),
{ recursive: true })` (`packages/core/src/infrastructure/sqlite/database.ts`) with
no guard; the raw `EEXIST` or `ENOENT` propagates out of `bootstrapService`, and
`runService`'s catch writes it to stderr and returns exit code 1 before `listen()` is ever
called (`packages/mcp/src/run.ts`). No listener binds; no partial service exists.

**What the caller sees.** Nothing over MCP; there is no server to connect to. An operator
reading the service's stderr sees a raw errno, not a domain error. `bootstrap.ts` defines
`GraphUnreachableError` and `SchemaNotInitializedError` for the neighboring startup checks,
but nothing names the SQLite path, so the message reads
`aion-mcp: Error: EEXIST: file already exists, mkdir '...'` rather than "aion could not
open its SQLite store at `<path>`."

**Diagnose.** `aion doctor`'s `volumes-writable` check (`packages/cli/src/doctor.ts`)
catches this before it becomes a startup failure: it probes `AION_DATA_DIR`, the SQLite
path's directory, and the log path's directory for a real write. Live, the stderr line above
is in `aion-mcp.launchd.err.log` beside the service log on a native install, and in `docker
logs aion-aion-mcp-1` on Docker. launchd's `KeepAlive` and compose's restart policy both
restart the service, which fails the same way until the path is fixed.

**Recovers.** Not until the path or its permissions are fixed. The next restart launchd or
compose makes then succeeds; `aion init` also starts the service and waits for its health on
either install.

### MCP client disconnects mid-call

**Trigger.** A client closes its transport (or drops off the network) while a `recall` or
`reflection` call is in flight, or afterward with no clean shutdown.

**What happens.** The in-flight call keeps running to completion server-side; nothing
cancels it. A client-side `transport.close()` sends no MCP `DELETE` (verified against the
SDK: `Client.close()` aborts the local transport and never issues the request
`onsessionclosed` depends on, EX-32). The server-side session for that client stays in
the session map (`packages/mcp/src/session-registry.ts`) rather than closing right away. Two
backstops bound the map instead of leaving it to leak: the registry evicts down to
`MAX_SESSIONS = 512` on every new session past the cap (logged as `mcp session evicted`), and
`SessionIdleSweeper` (`packages/mcp/src/session-idle-sweeper.ts`) closes any session with no
request in `AION_SESSION_IDLE_EXPIRY_MINUTES` (default 30), independent of the count. Closing
a session either way runs the same teardown as an explicit DELETE: the narrative-close hook
fires and the session leaves the map, so a request that arrives after gets the same clean
`unknown session` 404 a never-opened one would.

**What the caller sees.** Nothing; it disconnected. Its own in-flight promise rejects
locally (`McpError -32000 Connection closed`) once its socket is gone. Other clients are
unaffected; the service does not restart.

**Diagnose.** `GET /health` returns `{status: "ok", sessions: <n>}`; a session count that
only grows across many short-lived clients without settling points at abandoned transports
rather than a leak in the handlers themselves.

**Recovers.** Automatically. The stale session is evicted under the 512 cap, closed by the
idle sweep, or sits idle at negligible cost until one of the two catches it.

## Budgets and caps

Every knob below is `AION_*`-overridable; the catalog is
`packages/core/src/infrastructure/config/knobs.ts`, which carries each type and default.

| Knob | Default | Buys (raising it) | Costs (raising it) | Vs. spec |
|---|---|---|---|---|
| `AION_CUE_CACHE_TTL_MINUTES` (`recall.cueCacheTtlMinutes`) | 30 | Under `AION_RECALL_MODE=cues` only, reuses successful cue results longer and avoids repeated generation calls. `0` disables storage and reuse. | Results can persist longer after model behavior changes. Entries expire from insertion time; the 256-entry FIFO limit still bounds memory. | Only this process shares the cache. Full request content and route identify an entry; failed extractions are not cached. |
| `AION_DAILY_CEILING_USD` (`anthropic.dailyCeilingUsd`; the older `AION_ANTHROPIC_DAILY_CEILING_USD` still sets it) | 5 | Raised, more generation may be committed in one UTC day before both routes start refusing. Every dispatch holds a maximum against this before it is sent (the request body in UTF-8 bytes, which no tokenizer over those bytes can beat, plus the call's own output cap) and settles at what it cost, so what it bounds is committed spend and not reported spend. | Lowered under a day's ordinary work, reflection queues and recall serves the retrieval ranking unassessed for the rest of the day; the substrate keeps capturing, embedding and reading the graph either way. Refusal is the missing-key shape, so nothing burns attempts against it. | New with the batch producer. The whole 2026-09-13 build round spent $5.12 across every chunk, so five is a runaway backstop rather than a working budget. A model the price table does not carry is held at the top of the published card instead of its own rate, so it is refused like anything else that does not fit, and `aion costs` counts those dispatches separately. |
| `AION_ANTHROPIC_PROMPT_CACHE` (`anthropic.promptCache`) | true | Repeated eligible system prefixes use five-minute provider caching at the read rate. | Cache creation costs 1.25x ordinary input. Short prefixes do not cache; per-call schemas in `system_prompt` mode can prevent reuse. | Anthropic route only, and inert on every production surface: no shipped prompt reaches Haiku 4.5's 4,096-token floor. [Live measurements](operations.md#prompt-caching) verified reuse with long synthetic controls in both modes. `false` disables the marker. The OpenAI route has no knob: it sends explicit cache mode with no breakpoint, so it writes nothing to the cache. |
| `AION_CUE_BUDGET_MS` (`recall.cueBudgetMs`) | 8000 | Headroom for recall's one model call, the assessment by default, so the hang guard stays a hang guard instead of firing on ordinary recalls. Live GPT-6 Luna assessments measured p50 1.6s, p95 2.6s and at most 4.4s over 119 recalls; an earlier cue model measured 2288ms cold. | A call that has actually hung blocks recall that much longer before the ladder degrades it. | PRD §14 pins 2000. Raised to 5000 in the original build, then to 8000 after a live gate rerun busted 2000 at a measured 2030ms. |
| `AION_EMBED_KEEP_ALIVE` (`ollama.embedKeepAlive`) | -1 | Raised to a positive number of seconds, Ollama gives the embed model's 1.2GB of unified memory back after that idle window instead of holding it resident forever. | Every reload after the window lands inside recall's embed stage, which the harness hooks await synchronously: measured against warm embeds under a second, reloads added 1 to 16 seconds, and the worst carried a session-start hook past its 10s timeout. Boot softens the first hit either way: `warmEmbedModel` (`packages/mcp/src/boot-models.ts`) embeds one probe at service start, fail-open, so a cold Ollama pays its load there rather than on the first recall. | New; no spec pin. |
| `AION_RECALL_MAX_EPISODES` (`recall.maxEpisodes`) | 20 | Room for a graph-traversal item to survive fusion against near-tie vector hits. The checkpoint's one traversal-reached item ranked 13th: absent from the pack at 5, 8, and 12, present at 20. | A bigger `episodes` bucket before the token budget trims it; `episodes` is the pack's largest bucket. | Whitepaper Appendix E pins 5. Checked live at 5/8/12/20; only 20 passed. |
| `AION_RECALL_TOKEN_BUDGET` (`recall.tokenBudget`) | 1200 | Nothing directly; this is the actual size ceiling on a pack, downstream of every bucket cap. | A pack trimmed harder, regardless of how many items the caps above admitted. | Not flagged as a deviation. |
| `AION_VECTOR_ADMISSION_FLOOR` (`recall.vectorAdmissionFloor`) | 0.35 | Keeps weak, near-random matches out of a pack on their own. Calibrated against snowflake-arctic-embed2 on 43 unrelated pairs and 10 genuine matches: unrelated p50 0.086, p95 0.267, max 0.299; related min 0.382, p05 0.438, p50 0.769. This model leaves a 0.083 valley where nomic-embed-text left an overlap, so both floors sit inside it: 0.35 is 0.032 under the weakest genuine match and admits every one of them on the vector leg alone. | A single-leg match under 0.35 needs a second corroborating leg to be admitted at all. `floor-calibration.int.test.ts` fails if the committed value stops separating the two distributions. | Replaces PRD §14's `AION_MIN_RELEVANCE`, which named one floor for every method. Was 0.60 against nomic-embed-text, whose noise sample reached 0.547. |
| `AION_CORROBORATION_FLOOR` (`recall.corroborationFloor`) | 0.33 | The lower bar a cosine has to clear to count as one of the two independent measurements that admit an item neither could carry alone. Set 0.031 above the noise sample's max (0.299), not merely its median, so two corroborating legs are two readings of signal rather than two readings of the same noise. | Lowered toward the noise ceiling, two unrelated cues start corroborating each other on noise alone. | Re-derived against snowflake-arctic-embed2 on 2026-09-02. |
| `AION_BM25_ADMISSION_MODE` (`recall.bm25AdmissionMode`) | `exact` | `exact` admits a Lucene match on the verbatim cue and nothing else from the lexical leg; `corroborated` makes even that need a second measurement; `any` restores the pre-floor behaviour, where one shared term admitted anything. | `any` is what EX-1 measured: normalize-to-best put the top hit of every query at 1.00, so five off-topic queries each filled the pack to budget. | New in the fix round. |
| `AION_RECALL_MAX_HOPS` (`recall.maxHops`) | 3 | Lets activation cross one `FOLLOWS` link between two episodes via the Session hub (`Episode-[:PARTICIPATES_IN]->Session-[:FOLLOWS]->Session-[:PARTICIPATES_IN]->Episode` is 3 hops). At 2, that path reaches only a contentless Session node. | Wider fan-out per iteration, more nodes visited before `maxNodesVisited` caps it. | Whitepaper Appendix E pins 2. |
| `AION_PACK_CLUSTER_CAP` (`recall.clusterCap`) | 2 | Stops one near-duplicate content cluster from filling a bucket. EX-22 measured a burst of near-identical episodes taking 29.5% of a pack's slots. | Raised, a repeated shape crowds out more of a bucket's real diversity before the cap stops it. | New in the fix round. |
| `contextResonance.seedLimit` / `.activationLimit` | 32 / 50 | `seedLimit` caps the scaled seed budget (`seedBudgetBase + seedBudgetGrowth * ln(population)`, 10 and 2); `activationLimit` bounds the co-activated set, so activation's cost is predictable. | A true signal ranked past the cap is not considered at all, not degraded. | Raised from a flat 10, which was the whole budget: ten seeds are the entire candidate set, so on a substrate of several thousand memories a node above the admission floor was never measured because it was never a candidate. The curve reaches 32 near sixty thousand memory nodes and stays under `activationLimit`. |
| `activation.maxNodesVisited` / `.hubThreshold` | 500 / 10 | Bounds worst-case traversal cost; the hub threshold keeps one high-degree node from flooding the frontier. | A legitimate multi-hop path through a dense area can be cut before it is explored. | Not flagged as a deviation. |
| Other bucket caps: `maxFacts` / `maxNarratives` / `maxIntentions` / `maxPreferences` / `maxResonant` / `vectorLimit` | 15 / 5 / 3 / 3 / 5 / 5 | Same shape as `maxEpisodes`: each decides what survives fusion for its bucket. | Same cost as `maxEpisodes`, unverified at other values: only the episode cap has a live pass/fail checkpoint behind it. `resonant` gained its producer with the second recall pass; `preferences` still has none, so that one cap is inert today. | Not flagged as a deviation. |
| `AION_RECALL_INTENTIONS` / `AION_RECALL_INTENTION_SITUATION_FLOOR` | true / 0.5 | The kill switch on standing intentions coming back on their own trigger, and the cosine a situation trigger has to clear against the centroid the second pass built. Off restores the pack exactly as it was before intentions had triggers. | The floor is borrowed from `contextSearchThreshold` rather than measured: a situation trigger reads an episode's content vector against a mean of context vectors, which is not the comparison that number was derived on. Too low and every open intention resonates with everything; the entity and temporal triggers are unaffected either way. | New; no spec pin, and the floor is a starting value to re-derive. |
| `AION_WORKER_COUNT` (`operational.workerCount`) | 1 | Concurrent reflection claim-and-run slots on one shared queue claimant, so more than one episode enriches at once. | Every worker calls the same hosted model for its stages under one daily ceiling, and nothing prioritizes between them; see the note below. | PRD §7 pins 1. |
| `AION_LANE_SESSION_ARRIVAL_MAX` (`lanes.sessionArrivalMax`) | 10 | Head-room for a legitimate session-end flush of a long conversation, which arrives as several episodes at once and must stay interactive. | Raised far enough, a client flooding from one session keeps priority for longer before the backstop sees it. The measured flood ran 51 arrivals per session per minute. | New in the fix round. |
| `AION_LANE_GLOBAL_ARRIVAL_MAX` (`lanes.globalArrivalMax`) | 120 | Arrivals across every session inside the window before the substrate counts as hot. Twelve busy sessions' worth. | Below ordinary multi-agent load, every session drops to the hot allowance for no reason. | New in the fix round. |
| `AION_LANE_HOT_SESSION_ARRIVAL_MAX` (`lanes.hotSessionArrivalMax`) | 3 | The per-session allowance while the substrate is hot; what stops enough fresh sessions from reproducing the flood with every per-session counter reading green. | At 1, a single retry during someone else's flood costs a legitimate session its lane. | New in the fix round. |
| `AION_RECONCILE_WARN_THRESHOLD` (`operational.reconcileWarnThreshold`) | 50 | Unenriched episodes `aion doctor` tolerates before it warns. | Raised past a real backlog, doctor goes back to reporting all-green over a substrate hours behind, which is the state EX-41 was filed for. | New in the fix round. |
| `AION_LAG_OLDEST_UNCLAIMED_WARN_MS` (`operational.lagOldestUnclaimedWarnMs`) | 600000 | Age of the oldest unclaimed job `aion doctor`'s `queue-lag` check tolerates before it warns. | Raised past a real backlog, doctor stops naming a queue that has gone stale. Ten minutes is inside the 1.9 to 6.7 episodes/min drain rate EX-10 measured. | New in the fix round. |
| `AION_LAG_QUEUE_DEPTH_WARN_THRESHOLD` (`operational.lagQueueDepthWarnThreshold`) | 200 | Total unclaimed jobs, either lane, `aion doctor`'s `queue-lag` check tolerates before it warns. | Raised past a real backlog, the same silence as above but by depth instead of age; either alone can miss a starved-then-drained queue the other catches. | New in the fix round. |
| `AION_KEYED_NARRATIVE_EPISODES` / `AION_KEYED_NARRATIVE_SENTENCES` / `AION_KEYED_NARRATIVE_EPISODE_CHARS` | 120 / 12 / 4000 | How much of a session one synthesis reads and how long its answer runs. The same three govern the day and week rollups and the subject consolidation, so one rule sizes every synthesis source. | A longer prompt and a longer answer per call. A session past 120 episodes is read in chunks rather than clipped, so this number sets the chunk size and one narration costs `ceil(n / 120) + 1` calls. | Sized to what Haiku takes in one call rather than measured; GPT-6 Luna's window is larger. Every hosted route reads these. `AION_REFLECTION_MAX_NARRATIVE_EPISODES` (40) and `AION_REFLECTION_MAX_NARRATIVE_EPISODE_CHARS` (2000) size only a provider with no route, which no installation has since generation became hosted-only. |
| `AION_PROPOSAL_RESOLUTION` / `AION_RESOLUTION_BATCH` (`maintenance.proposalResolution`, `.resolutionBatch`) | true / 10 | Open proposals decided on their merits in the run that reads them, oldest first across both queues, instead of waiting for a person and then for the hygiene horizon. Each row costs two model calls and a handful of graph reads, so ten is an hour's modest spend. | A larger batch puts more of one window into model calls, and a wrong verdict reaches the graph an hour after the row was filed rather than a fortnight. Off, both queues wait for `aion proposals` and the hygiene horizon behind it. | New with the autonomous queues. Nothing about it is one-way: every verdict is ledgered under `introspection:resolution:` with both passes' reasons, and `aion unsupersede`, `aion unmerge`, and `aion proposals reopen` reverse a resolver decision the same way they reverse a person's. |
| `AION_REFLECTION_MIN_EXTRACTION_CHARS` (`reflection.minExtractionChars`) | 64 | More subagent-stop progress lines (a short status line, a small tool result) skip extraction and its model call, since a capture under the floor is stored and embedded but not read by the generating stages. Bounds one capture class only: an ordinary short turn, observation, or tool result is still extracted as before. | A subagent synthesis long enough to carry real structure, but still under the floor, is stored with no entities or cognitive nodes pulled out of it. | New; no spec pin. Unmeasured, a deliberately low starting value. |
| `AION_REFLECTION_MAX_CONTRADICTION_JUDGMENTS` (`reflection.maxContradictionJudgments`) | 24 | Room for a full six-subject, three-neighbor supersession search (up to eighteen pairs) to finish in one run, with headroom for the keyed leg's own candidates on top, instead of starving on whichever subjects sort first in `text_norm` order. | More judge calls (up to two per pair under `unanimous`: the judgment and the second pass arguing the other side) spent per reflection run that reaches this stage. | Raised from 8, which starved a correction sorting past the fourth subject. Measured on claude-haiku-4-5: single judgments 1.5-1.7s, a full 24-judgment run extrapolates to roughly 35-40s, inside both the per-call 60s stage-timeout guard and the 600s stale-claim reclaim window. |
| `AION_MAINTENANCE_DESCRIPTION_REFRESH_BATCH` (`maintenance.descriptionRefreshBatch`) | 10 | More stale entity glosses are nominated onto the batch lane in one maintenance pass instead of trickling in three at a time; a measured substrate already had 23 qualified and waiting. | One batched generation plus one embed per entity, at half the ordinary rate and settled on a later tick, so a bigger batch spends more of the day's ceiling rewriting stored text in place. | New; no spec pin. |
| `AION_MAINTENANCE_DESCRIPTION_REFRESH_MENTION_GROWTH` (`maintenance.descriptionRefreshMentionGrowth`) | 2 | Fewer stale glosses need refreshing on a given pass, since a description stays fresh until it has accumulated the higher mention count a bigger value would require. | A gloss that gained real traffic since its last write keeps reading stale for longer before it qualifies for a rewrite. | New; no spec pin. Lowered from 5, which left a slow-moving entity's gloss stale indefinitely; 2 is low enough that a slow-moving entity still qualifies within a few sessions. |
| `AION_MAINTENANCE_NARRATIVE_EDGE_REPAIR_BATCH` (`maintenance.narrativeEdgeRepairBatch`) | 500 | Clears more of the backlog of `SUMMARIZED_BY` edges left pointing at an already-superseded narrative per run (measured 90.6% of 3,043 stored edges, about 2,757, against 285 live edges doing the work); at 500 an hour the backlog drains in about six runs. | One relationship scan plus two property writes per edge in a single run, no model call and no node write, so a larger batch spends graph write volume rather than model spend. | New; no spec pin. Higher than the 10-session `narrativeCleanupBatch` beside it because the per-edge work is cheaper and the backlog is a multiple of the narrative count. |
| `AION_SESSION_IDLE_EXPIRY_MINUTES` (`operational.sessionIdleExpiryMinutes`) | 30 | How long an MCP transport session may sit with no request before `SessionIdleSweeper` closes it, the backstop for a `client.close()` that never sends DELETE (EX-32). | Lowered, a client that legitimately pauses (an editor idle between edits) loses its session and its next call gets `unknown session` instead of resuming one. | New in the fix round. |

Raising `AION_WORKER_COUNT` past 1 runs more reflection jobs' hosted calls at once. The
provider's rate limits and the daily ceiling bound them, not this machine. Embedding stays
local: `attach_vectors` jobs, recall's embed stage and the maintenance embeds share one
host Ollama endpoint (`AION_OLLAMA_URL`), and by default Ollama serializes requests to one
model. Set `OLLAMA_NUM_PARALLEL` on the **host** Ollama process (not an `AION_*` var;
Ollama runs on the host, not in a container) to raise its per-model concurrency alongside
the worker count.

### Queue starvation

A backlog is not a degradation rung (nothing is broken and no signal is lost), but it is
what a caller feels when its own last turn is not recallable yet. The queue serves the
interactive lane strictly before the bulk one, and round-robins across sessions inside a
lane, so one session's flood delays another session's next episode by one job rather than by
the whole flood. Measured, unhandled: 4,016 unclaimed jobs, days of work at the 1.9 to 6.7
episodes/min the local model then drained, with every legitimate episode behind them in
insertion order.

Both halves have an operator surface. `aion queue ls` shows depth, age and per-lane totals;
`aion queue promote --session <id>` pulls one session's jobs to the front; `aion queue drop`
sheds unclaimed rows after printing the count. Shedding leaves the episodes stored and
unenriched, which `aion queue reconcile` counts and `--re-enqueue` hands back to the queue in
the bulk lane.

The same lag is visible without touching the queue directly. `/health` and `aion status`
report queue depth per lane, the oldest unclaimed job's age, the exhausted-attempts count,
the reinforcement queue's cumulative dropped-row counter, and the p95 of intake-to-enriched
lag over a rolling window of completed jobs. `aion doctor`'s `queue-lag` check warns (never
fails) past `AION_LAG_OLDEST_UNCLAIMED_WARN_MS` / `AION_LAG_QUEUE_DEPTH_WARN_THRESHOLD`. The
reflection ack carries `pending_ahead` (unclaimed interactive-lane jobs ahead of it at
enqueue time), and a recall pack's metadata carries `pending_enrichment`: the calling
session's own episodes with no orchestrator ledger key yet (EX-11), so an agent can tell its
own last few turns are still thin before it asks why a fact from them was not found.

## The maintenance loop

The introspection loop runs on the service's own clock: observe the substrate, decide which
one operation this cycle calls for, run it, score what it did. None of it is on the read or
the write path, so every mode below costs maintenance and costs a caller nothing.

**Observation fails (Neo4j down, SQLite unreadable).** The cycle falls back to a snapshot of
nothing, which selects nothing, and the wait before the next attempt doubles up to eight
intervals. Acting on a substrate the loop cannot see is the one thing it must not do, so a
partial reading also parks every pending measurement instead of scoring runs against a
collector that fell back to a neutral value.

**One collector fails and the rest answer.** The snapshot names that collector in `degraded`
and keeps the metrics it did get. An operation whose own metric came from the failed
collector is not scored this cycle; its pre-run reading waits for a whole snapshot.

**An operation throws.** It costs its own turn and nothing else. The failure is recorded
against that operation, which lowers its effectiveness and therefore its urgency on later
cycles. The ledger entry for the window says `failed` with the message. The loop outlives
every tick: a tick that could not finish is logged and the next one starts clean.

**Two service instances tick at once.** Each operation claims a calendar-aligned time bucket
in the ops ledger before it starts, and the claim is an insert that loses to whoever inserted
first. The instance that loses skips the window. Ticks are also jittered around the interval
so two instances started together drift apart instead of racing every time.

**A crash mid-operation.** The claim lands before the run, so the window stays claimed until
it rolls over. That is the deliberate trade: maintenance that skips a window costs one
cadence, and maintenance that reruns over a partial first pass costs whatever the operation
was halfway through.

**A job keeps failing.** No row is abandoned and none waits on a person. A reflection job that
spends its attempts stays queued with its last error, and `dead_letter` gives it one more cycle
in the bulk lane and wakes the worker for it. After that the row gets a cycle only when
something that could change its outcome has changed: the running build (`AION_BUILD_SHA`), the
readiness policy, the generation route, or its source's evidence (a new processing generation or
a newly accepted reference batch). Each cycle records the conditions it ran under in the ops
ledger. A failure that repeats under conditions already tried is held rather than retried in a
loop, and it stays visible as `deadLetterAttentionCount` in the health snapshot. Stage results
an earlier cycle applied stay applied.

**Diagnose.** `aion stats` has a `maintenance` section: the cycle count, and per operation
the runs, how many improved the metric they declared, how many changed nothing, how many
failed, how many no metric scored, what a run typically costs, and the last window's outcome.
An operation that has never been selected says so rather than reporting zeroes.

## Deferred gaps

**Two bounded, non-lossy artifacts, not tracked as gaps.** `ensureSession` runs before the
episode write, so a graph outage that lands between the two leaves a Session node with no
Episode attached. And a client that disconnects without a clean MCP shutdown leaves its
server-side session in the map until the idle sweep or the 512-session cap closes it. Neither loses data or
grows unbounded.

**A pending-vector node still has no expiry of its own.** Nothing in the graph ages one out:
it stays vectorless until something embeds it. That is deliberate (the marker is the absence
of the property, so there is no flag to go stale). Three things clear it: the `attach_vectors`
queue row every acceptance writes, the worker's startup drain over the whole backlog, and the
`vector_backfill` operation, which reads the same parity the doctor reports. A parity under 0.8
on a substrate of at least 20 vector-bearing nodes is a tier-1 condition that preempts the
routine catalog.

**Batched generation carries one surface.** The batch path is built, durable and tested on
both providers' batch APIs ([operations](operations.md#batched-generation)). The
`batch_settlement` operation pumps it, and `description_freshness` produces into it: entity
glosses that fell behind their mentions are re-synthesized at half price, revalidated against
the entity before they are applied, and applied through the same guarded write the inline call
used. Every other generation still runs as an ordinary call at full price; no other stage
registers a batch handler yet.

**A spent daily ceiling looks like a substrate with no key.** `AION_DAILY_CEILING_USD` ($5) is
held against before every dispatch, by both routes and either provider, from one durable book.
When a day cannot cover the next request, background work goes back on the queue without spending
an attempt, batch submissions are not sent and their work stays queued, and recall serves the
retrieval ranking with `degraded: assessment/unavailable`. The substrate keeps capturing, embedding,
reading the graph and serving what it already holds. While it holds, nothing spends an attempt
or sends a request: the worker rechecks after each breaker cooldown
(`AION_WORKER_BREAKER_COOLDOWN_MS`) and each recheck is refused before dispatch. The first
recheck after the UTC day turns resumes the work; a raised number takes effect when `aion init`
restarts the service. `aion costs` prints the day against the ceiling.
