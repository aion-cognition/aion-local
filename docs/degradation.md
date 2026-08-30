# Degradation modes

## Principle

Degradation means doing less inference, never switching to heuristics: a broken cue model
loses ranking signal, it never falls back to keyword matching (PRD §6.1). Every degraded
answer names itself in `metadata.degraded`, a list of `{stage, reason}` entries, one per
rung that fired. An empty pack beats a noisy one: a floor nothing clears, or a substrate
with nothing relevant, returns cleanly empty rather than padded with weak matches.

## The ladder

Each mode below states the trigger, what the pipeline does, the exact shape the caller
receives, how to diagnose it live, and how it recovers. Every claim is sourced from a
probe run against the current code: a throwaway Neo4j plus host Ollama for the six modes
with live evidence, and the existing unit suite for the one that only needs process
inputs. Numbers are wall-clock from that run, not guarantees.

### Cue extraction failure (timeout, model error, malformed output)

**Trigger.** The one `generate` call recall spends on cue extraction (PRD §10's hot-path
rule) times out, the model errors, or its output fails schema validation.

**What happens.** `extractCues` (`packages/core/src/recall/application/cues.ts:230`)
catches all three under one rung. `callCueModel` wraps the call in an `AbortController`
keyed to `AION_CUE_BUDGET_MS`; an abort is classified `timeout`, anything else
`model_error` (`cues.ts:145-162`). A response that parses but fails
`CueModelOutputSchema.safeParse` is `invalid_output` (`cues.ts:244-247`). All three call
`degradedResult`, which builds cues from the caller's own query and summary text verbatim
(query at weight 3, summary at weight 2) and never derives terms from it (`cues.ts:175-189`).
Only a successful extraction is cached (`CueCache.set`, `cues.ts:58-66`), so a degraded
call never poisons a later one for the same input.

**What the caller sees.** A normal `MemoryPack`. `metadata.degraded` carries one entry:
`{stage: "cues", reason: "timeout" | "model_error" | "invalid_output"}`. BM25 and entity
resolution still run on the raw-query cue, so a real item can still come back.

**Diagnose.** `aion doctor`'s `ollama-round-trip` check catches a broken or unreachable
model before a caller hits it. Live, the service logs `cue extraction degraded` with the
model name and reason (`cues.ts:239`, `:245`). `aion last` prints `degraded  cues: <reason>`
above the pack (`packages/cli/src/last.ts:106-108`).

**Recovers.** Automatically, next call. No state to reset.

Verified by the unit suite, not live-induced: `cues.test.ts:144` (a degraded result is
never cached), `:215` and `:224` (both `invalid_output` shapes), `:233` (timeout). 18/18
pass (`npx vitest run packages/core/src/recall/application/cues.test.ts`).

### Full Ollama outage: recall

**Trigger.** `AION_OLLAMA_URL` points at nothing reachable. Both the cue-model call and
the embedding call fail.

**What happens.** Cue extraction degrades as above (`reason: model_error`). `embedCues`
(`recall.ts:132-142`) then tries to embed the degraded cues, fails, and returns them
without vectors, logging `cue embedding failed` (`recall.ts:140`). `handleRecall` collects
every rung that fired, in stage order, into one list (`recall.ts:269-281`). With no
vectors, BM25, entity resolution, recency, and graph traversal carry the recall alone.

**What the caller sees.** A `MemoryPack` with `metadata.degraded` holding **two** entries:
`[{stage: "cues", reason: "model_error"}, {stage: "embed", reason: "model_error"}]`. This
is what closes the old gap: before the fix, `metadata.degraded` could only ever hold one
`cues` entry, so a dead cue model and a dead Ollama produced an identical pack and the
caller could not tell "ranking is thinner" from "the whole inference stack is down."

Re-verified live (`AION_OLLAMA_URL=http://127.0.0.1:9`, throwaway Neo4j, real episode
seeded): `metadata.degraded` came back exactly
`[{"stage":"cues","reason":"model_error"},{"stage":"embed","reason":"model_error"}]`.

**Diagnose.** `aion doctor`'s `ollama-round-trip` check. Live, both log lines above fire
in the same request. `aion last` prints two `degraded` lines.

**Recovers.** Automatically, next call, once Ollama answers again.

### Full Ollama outage: reflection

**Trigger.** Same outage, on the write path. Intake makes one embedding call, and it makes
it after the write transaction has already committed
(`packages/core/src/reflection/application/intake.ts:254-267`).

**What happens.** Nothing, to the experience. The write transaction commits the `Episode`,
its `Turn` nodes, and every backbone edge with no `content_vec` property at all
(`intake.ts:123-169`); the integrate job is inserted and the dispatcher signalled
(`intake.ts:312-321`); only then does `attachVectors` embed. The call throws, it is logged
as `content vectors deferred; the episode is stored and queued`, and intake returns
normally (`intake.ts:254-267`). A `:Memory` node without `content_vec` is itself the
pending marker; there is no flag property to keep in sync with it
(`packages/core/src/infrastructure/graph/pending-vectors.ts`).

**What the caller sees.** The ordinary ack, `{episode_id, queued: true}`. No MCP error.
`ReflectionNotStoredError` no longer has an `embed` stage at all: the only way intake can
refuse is an unreachable graph.

Until the backfill runs, the episode is reachable by BM25, entity resolution, recency, and
traversal, and invisible to vector search, the same shape as the recall-side outage above,
and for the same reason. It is ranking that is missing, not the memory.

**Diagnose.** `aion doctor`'s `ollama-round-trip` check. Live, the warn line above names the
episode id and how many nodes are waiting. `findPendingVectorNodes(driver, limit)` returns
the outstanding set directly.

**Recovers.** Automatically, once Ollama answers. `attachContentVectors` over
`findPendingVectorNodes` is the backfill (`reflection/application/vectors.ts`); the
reflection worker runs it in its startup drain (P3) and `vector_backfill` schedules it as a
maintenance operation (P5). Re-running it over already-vectorized nodes is a no-op, so a
partial drain simply resumes.

Verified against a throwaway Neo4j plus an Ollama pointed at the discard port
(`reflection/application/intake-vectors.int.test.ts`, 9/9 pass): the episode, both turns,
`PARTICIPATES_IN`, and the turn `FOLLOWS` chain all present, the queue row present, the
dispatcher signalled, and `content_vec` absent on all three nodes.
`findPendingVectorNodes` then returned exactly those three ids, `attachContentVectors`
against live Ollama filled all three at 768 dimensions, a second pass wrote the same
vectors and left the pending set empty. The failing embed call itself costs 12ms
(`TypeError: fetch failed`), measured against `http://127.0.0.1:9`.

### Neo4j down: recall

**Trigger.** The graph is unreachable mid-service: stopped, network-partitioned, or
otherwise not answering Bolt.

**What happens.** All four seed strategies (`vector`, `bm25`, `entity_resolution`,
`recency`) issue their Cypher independently and in parallel; each per-strategy failure is
isolated by `settle()`, which contributes nothing rather than failing the call
(`packages/core/src/recall/application/seeds.ts:273-289`). `selectSeeds` also counts
attempts and rejections across every leg: when every query issued was rejected, it sets
`graphUnavailable: true` and logs `every seed query failed; treating the graph as
unavailable` (`seeds.ts:462-464`). The recency leg always issues exactly one query, which
is what makes "nothing attempted" distinguishable from "everything rejected."
`handleRecall` turns that flag into `{stage: "graph", reason: "unavailable"}`
(`recall.ts:280`). With zero seeds, activation short-circuits
(`recall.ts:285-286`) and the pack assembles empty.

**What the caller sees.** `metadata.degraded: [{stage: "graph", reason: "unavailable"}]`.
This is the other half of the fix: before it, this same outage produced a normal-looking
empty pack with **no** degradation marker at all, byte-identical to a genuine "nothing
matches" miss.

`rendered_text` now carries it too. `assemblePack` builds one plain line from the three
honesty signals and renders it directly under the heading, before any bucket:

```
# Memory

note: degraded graph reads (unavailable)

No memories matched this query.
```

The line names each degradation rung, then a spread that stopped on the activation budget
(`metadata.truncated`), then the calling session's un-enriched episode count
(`metadata.pending_enrichment`), joined by `; `. It is absent entirely on a healthy pack and
present on an empty one, which is where a caller most needs it. This closes the gap the
previous revision of this page recorded: an agent reading only the tool's text content, not
`structuredContent.metadata`, could not tell an outage from an honest miss, and one exercise
angle lost a full baseline run to exactly that.

Re-verified live before the fix (`docker stop` on the harness Neo4j mid-service, then a
recall against a warm session): resolved in 16.6-17.6s across two runs (down from the pre-fix
62-66s, driven by the driver-timeout fix below) with `metadata.degraded` exactly
`[{"stage":"graph","reason":"unavailable"}]` and `rendered_text` then still the bare
empty-pack constant.

**Diagnose.** `aion doctor`'s `neo4j-bolt` check (`packages/cli/src/doctor.ts:74-85`), which
every other check depends on. Live, `selectSeeds`' error log line above names it directly.
`aion last` prints `degraded  graph: unavailable`.

**Recovers.** Automatically, no restart. `GraphConnection` holds one driver for the
process life (`packages/core/src/infrastructure/graph/connection.ts:143-193`); its pool
reconnects on its own once Neo4j answers again.

### Context resonance failure (graph error on the second pass)

**Trigger.** The second pass's graph reads, the context-vector fetch that builds the centroid
or the search against the context index, fail after the first pass has already produced a
pack.

**What happens.** `resonate` (`packages/core/src/recall/application/resonance.ts:147-190`)
wraps both reads in one try/catch. A graph error there is caught, logged as `context resonance
failed; the pack keeps its first-pass answer` (`resonance.ts:188`), and returns `{items: [],
skipped: 'unavailable'}` instead of propagating. `handleRecall` logs the skip reason on its own
`recall served` line (`recall.ts:392`, field `resonanceSkipped`) but does not add it to
`degradations` (`recall.ts:275-284`), the list `metadata.degraded` is built from.

**What the caller sees.** The pack the first pass already assembled, with an empty `resonant`
bucket and no `metadata.degraded` entry naming resonance. This is the one rung on this ladder
that stays silent to the caller by design: the module comment calls swallowing the error the
right trade ("losing a whole recall to the associative stage would be the wrong trade every
time"), and the cost is that the same empty resonant bucket looks identical whether the query
genuinely had no associative match or the graph read failed underneath it.

**Diagnose.** Not visible over MCP. Live, the service log's `resonanceSkipped: "unavailable"`
field on the `recall served` line is the only signal; `aion doctor`'s `neo4j-bolt` check
catches the underlying outage if it is still live when doctor runs.

**Recovers.** Automatically, next call, once the graph answers again. No state to reset.

Verified by the unit suite, not live-induced: `resonance.test.ts:134-143` fails the driver's
`executeQuery` call and asserts `skipped: 'unavailable'` with an empty item list and nothing
thrown past `resonate`.

### Neo4j down: reflection

**Trigger.** Same outage, on the write path, for a session whose identity has not been
resolved to a Session node yet (a fresh MCP connection, or the process's first reflection
for that identity). `SessionManager.ensureSession` caches resolved identities in memory
(`packages/core/src/session/session-manager.ts:46-49`); a cache hit needs no graph call and
is unaffected by the outage.

**What happens.** `ensureGraphSession` issues a write inside `storeDurably`
(`intake.ts:207-223`). It fails; `isGraphUnavailable` recognizes the driver's
`ServiceUnavailable`/`SessionExpired` codes (or an unlabeled connection-acquisition
timeout) and `storeDurably` wraps it in `ReflectionNotStoredError('graph', err)`
(`intake.ts:219`) rather than letting the raw `Neo4jError` escape. This is the one refusal
the write path still makes: an unreachable graph has nowhere to put the experience, so
answering `queued: true` would lose it for good.

**What the caller sees.** An MCP `InternalError` (-32603):
`reflection not stored: the graph is unavailable (Neo4jError). Nothing was written and
nothing was queued; send this reflection again once the service is back.`

Re-verified live: a fresh client's reflection during the same outage window above failed
in 15.4-16.0s across two runs and returned exactly that message. Pre-fix, the same failure
took ~32s (the driver's default 30s transaction-retry budget) and, on a client with the MCP
SDK's default 60s request timeout, sometimes arrived as a bare `-32001 Request timed out`
with the server's real error lost entirely.

**Diagnose.** `aion doctor`'s `neo4j-bolt` check. Live, `tools.ts:109`'s `tool call failed`
log line carries the same message the caller received.

**Recovers.** Not automatically. Nothing was written or queued; resend once Neo4j is back.
The identity that failed is still unresolved, so the retry pays for `ensureSession` again,
this time against a healthy graph.

Re-verified against a live harness with a second driver pointed at a dead Bolt port
(`intake-vectors.int.test.ts`): the call raised `ReflectionNotStoredError` with stage
`graph`, and the healthy graph held zero `Episode` and zero `Turn` nodes for that session
with no queue row and no dispatcher signal.

### Driver timeouts, underneath both Neo4j modes

`GraphConnection`'s constructor used to take the neo4j-driver defaults as-is: 60s to
acquire a pooled connection, 30s of transaction retries
(`packages/core/src/infrastructure/graph/connection.ts:126-133`). Both meet or exceed the
MCP SDK client's own 60s request timeout, which is why the pre-fix numbers above include a
case where the server's named error never reached the caller at all. The connection is now
constructed with `connectionTimeout: 5000`, `connectionAcquisitionTimeout: 10_000`,
`maxTransactionRetryTime: 10_000` (`connection.ts:134-136`, applied at `:153-155`). A
healthy pool answers in microseconds, so these only bite during an outage, and the live
numbers above land inside them.

### SQLite unwritable at startup

**Trigger.** `AION_SQLITE_PATH`'s directory cannot be created: it already exists as a
regular file, or its parent does not exist and cannot be made.

**What happens.** `bootstrapService` constructs `SqliteStore` before anything else,
including the Neo4j health check (`packages/mcp/src/bootstrap.ts:75-76`).
`openSqliteHandle` calls `mkdirSync(dirname(filePath), { recursive: true })`
(`packages/core/src/infrastructure/sqlite/database.ts:57-61`) with no guard; the raw
`EEXIST` or `ENOENT` propagates out of `bootstrapService`, and `runService`'s catch writes
it to stderr and returns exit code 1 before `listen()` is ever called
(`packages/mcp/src/run.ts:40-45`). No listener binds; no partial service exists.

**What the caller sees.** Nothing over MCP; there is no server to connect to. An operator
reading `docker logs` sees a raw errno, not a domain error: `bootstrap.ts` defines
`GraphUnreachableError` and `SchemaNotInitializedError` for the neighboring startup checks
(`bootstrap.ts:35-45`) but nothing names the SQLite path, so the message reads
`aion-mcp: Error: EEXIST: file already exists, mkdir '...'` rather than "aion could not
open its SQLite store at `<path>`."

**Diagnose.** `aion doctor`'s `volumes-writable` check (`packages/cli/src/doctor.ts:145-155`)
catches this before it becomes a startup failure: it probes `AION_DATA_DIR`, the SQLite
path's directory, and the log path's directory for a real write. Live, `docker logs
aion-aion-mcp-1` shows the stderr line above; compose restarts the container, which fails
the same way until the path is fixed.

**Recovers.** Not automatically. Fix the path or its permissions, then let compose's
restart policy bring the container back, or `docker compose up -d --force-recreate
aion-mcp`.

### MCP client disconnects mid-call

**Trigger.** A client closes its transport (or drops off the network) while a `recall` or
`reflection` call is in flight, or afterward with no clean shutdown.

**What happens.** The in-flight call keeps running to completion server-side; nothing
cancels it. A client-side `transport.close()` sends no MCP `DELETE` (verified against the
SDK: `Client.close()` aborts the local transport and never issues the request
`onsessionclosed` depends on (EX-32), so the server-side session for that client stays in
the session map (`packages/mcp/src/service.ts`) rather than closing right away. Two
backstops bound it instead of a leak: the map evicts down to `MAX_SESSIONS = 512` on every
new session past the cap (logged as `mcp session evicted`), and `SessionIdleSweeper`
(`packages/mcp/src/session-idle-sweeper.ts`) closes any session with no request in
`AION_SESSION_IDLE_EXPIRY_MINUTES` (default 30), independent of the count. Closing a
session either way runs the same teardown as an explicit DELETE: the narrative-close hook
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
`packages/core/src/infrastructure/config/registry.ts`, typed defaults in `defaults.ts`.

| Knob | Default | Buys (raising it) | Costs (raising it) | Vs. spec |
|---|---|---|---|---|
| `AION_CUE_BUDGET_MS` (`recall.cueBudgetMs`) | 8000 | Headroom past a cold cue-model start (measured 2288ms cold vs. 558-811ms warm), so the hang guard stays a hang guard instead of firing on ordinary recalls. | A call that has actually hung blocks recall that much longer before the ladder degrades it. | PRD §14 pins 2000. Raised to 5000 in the original build, then to 8000 after a live gate rerun busted 2000 at a measured 2030ms. |
| `AION_RECALL_MAX_EPISODES` (`recall.maxEpisodes`) | 20 | Room for a graph-traversal item to survive fusion against near-tie vector hits. The checkpoint's one traversal-reached item ranked 13th: absent from the pack at 5, 8, and 12, present at 20. | A bigger `episodes` bucket before the token budget trims it; `episodes` is the pack's largest bucket. | Whitepaper Appendix E pins 5. Checked live at 5/8/12/20; only 20 passed. |
| `AION_RECALL_TOKEN_BUDGET` (`recall.tokenBudget`) | 1200 | Nothing directly; this is the actual size ceiling on a pack, downstream of every bucket cap. | A pack trimmed harder, regardless of how many items the caps above admitted. | Not flagged as a deviation. |
| `AION_VECTOR_ADMISSION_FLOOR` (`recall.vectorAdmissionFloor`) | 0.60 | Keeps weak, near-random matches out of a pack on their own. Calibrated against nomic-embed-text on 28 unrelated pairs and 10 genuine matches: unrelated p50 0.408, p95 0.530, max 0.547; related min 0.451, p50 0.773. The distributions overlap between 0.451 and 0.547, so no floor separates them cleanly; 0.60 sits above the whole noise sample and lets corroboration (below) admit the two genuine matches that fall inside the overlap. | A single-leg match inside the overlap band (measured min 0.451) needs a second corroborating leg to be admitted at all. `floor-calibration.int.test.ts` fails if the committed value stops separating the two distributions. | Replaces PRD §14's `AION_MIN_RELEVANCE`, which named one floor for every method. |
| `AION_CORROBORATION_FLOOR` (`recall.corroborationFloor`) | 0.55 | The lower bar a cosine has to clear to count as one of the two independent measurements that admit an item neither could carry alone. Set above the noise sample's max (0.547), not merely its median, so two corroborating legs are two readings of signal rather than two readings of the same noise. | Lowered toward the noise ceiling, two unrelated cues start corroborating each other on noise alone. | New in the fix round. |
| `AION_BM25_ADMISSION_MODE` (`recall.bm25AdmissionMode`) | `exact` | `exact` admits a Lucene match on the verbatim cue and nothing else from the lexical leg; `corroborated` makes even that need a second measurement; `any` restores the pre-floor behaviour, where one shared term admitted anything. | `any` is what EX-1 measured: normalize-to-best put the top hit of every query at 1.00, so five off-topic queries each filled the pack to budget. | New in the fix round. |
| `AION_RECALL_MAX_HOPS` (`recall.maxHops`) | 3 | Lets activation cross one `FOLLOWS` link between two episodes via the Session hub (`Episode-[:PARTICIPATES_IN]->Session-[:FOLLOWS]->Session-[:PARTICIPATES_IN]->Episode` is 3 hops). At 2, that path reaches only a contentless Session node. | Wider fan-out per iteration, more nodes visited before `maxNodesVisited` caps it. | Whitepaper Appendix E pins 2. |
| `AION_PACK_CLUSTER_CAP` (`recall.clusterCap`) | 2 | Stops one near-duplicate content cluster from filling a bucket. EX-22 measured a burst of near-identical episodes taking 29.5% of a pack's slots. | Raised, a repeated shape crowds out more of a bucket's real diversity before the cap stops it. | New in the fix round. |
| `contextResonance.seedLimit` / `.activationLimit` | 10 / 50 | Bounds the seed set and the co-activated set per recall, so activation's cost is predictable. | A true signal ranked past the cap is not considered at all, not degraded. | Not flagged as a deviation; matches the whitepaper's seed budget. |
| `activation.maxNodesVisited` / `.hubThreshold` | 500 / 10 | Bounds worst-case traversal cost; the hub threshold keeps one high-degree node from flooding the frontier. | A legitimate multi-hop path through a dense area can be cut before it is explored. | Not flagged as a deviation. |
| Other bucket caps: `maxFacts` / `maxNarratives` / `maxPreferences` / `maxResonant` / `vectorLimit` | 15 / 5 / 3 / 5 / 5 | Same shape as `maxEpisodes`: each decides what survives fusion for its bucket. | Same cost as `maxEpisodes`, unverified at other values: only the episode cap has a live pass/fail checkpoint behind it. `resonant` gained its producer with the second recall pass; `preferences` still has none, so that one cap is inert today. | Not flagged as a deviation. |
| `AION_WORKER_COUNT` (`operational.workerCount`) | 1 | Concurrent reflection claim-and-run slots on one shared queue claimant, so more than one episode enriches at once. | Every worker still calls the same host Ollama for its model stages (`AION_REFLECT_MODEL`), and nothing prioritizes between them; see the contention note below. | PRD §7 pins 1. |
| `AION_LANE_SESSION_ARRIVAL_MAX` (`lanes.sessionArrivalMax`) | 10 | Head-room for a legitimate session-end flush of a long conversation, which arrives as several episodes at once and must stay interactive. | Raised far enough, a client flooding from one session keeps priority for longer before the backstop sees it. The measured flood ran 51 arrivals per session per minute. | New in the fix round. |
| `AION_LANE_GLOBAL_ARRIVAL_MAX` (`lanes.globalArrivalMax`) | 120 | Arrivals across every session inside the window before the substrate counts as hot. Twelve busy sessions' worth. | Below ordinary multi-agent load, every session drops to the hot allowance for no reason. | New in the fix round. |
| `AION_LANE_HOT_SESSION_ARRIVAL_MAX` (`lanes.hotSessionArrivalMax`) | 3 | The per-session allowance while the substrate is hot; what stops enough fresh sessions from reproducing the flood with every per-session counter reading green. | At 1, a single retry during someone else's flood costs a legitimate session its lane. | New in the fix round. |
| `AION_RECONCILE_WARN_THRESHOLD` (`operational.reconcileWarnThreshold`) | 50 | Unenriched episodes `aion doctor` tolerates before it warns. | Raised past a real backlog, doctor goes back to reporting all-green over a substrate hours behind, which is the state EX-41 was filed for. | New in the fix round. |
| `AION_LAG_OLDEST_UNCLAIMED_WARN_MS` (`operational.lagOldestUnclaimedWarnMs`) | 600000 | Age of the oldest unclaimed job `aion doctor`'s `queue-lag` check tolerates before it warns. | Raised past a real backlog, doctor stops naming a queue that has gone stale. Ten minutes is inside the 1.9 to 6.7 episodes/min drain rate EX-10 measured. | New in the fix round. |
| `AION_LAG_QUEUE_DEPTH_WARN_THRESHOLD` (`operational.lagQueueDepthWarnThreshold`) | 200 | Total unclaimed jobs, either lane, `aion doctor`'s `queue-lag` check tolerates before it warns. | Raised past a real backlog, the same silence as above but by depth instead of age; either alone can miss a starved-then-drained queue the other catches. | New in the fix round. |
| `AION_SESSION_IDLE_EXPIRY_MINUTES` (`operational.sessionIdleExpiryMinutes`) | 30 | How long an MCP transport session may sit with no request before `SessionIdleSweeper` closes it, the backstop for a `client.close()` that never sends DELETE (EX-32). | Lowered, a client that legitimately pauses (an editor idle between edits) loses its session and its next call gets `unknown session` instead of resuming one. | New in the fix round. |

Raising `AION_WORKER_COUNT` past 1 buys nothing on its own: the reflection worker, the
recall cue model, and the idle narrative sweeper all share one host Ollama endpoint
(`AION_OLLAMA_URL`), and by default Ollama itself serializes requests to one model. Set
`OLLAMA_NUM_PARALLEL` on the **host** Ollama process (not an `AION_*` var; Ollama runs on
the host, not in a container) to raise its per-model concurrency alongside the worker count.
Measured contention without it: recall wall p50 rose from 945ms to 4,463ms (372%) under a
busy reflection worker, and the worker itself lost about 9% throughput under concurrent
recalls (1.98 to 1.80 episodes/min).

### Queue starvation

A backlog is not a degradation rung (nothing is broken and no signal is lost), but it is
what a caller feels when its own last turn is not recallable yet. The queue serves the
interactive lane strictly before the bulk one, and round-robins across sessions inside a
lane, so one session's flood delays another session's next episode by one job rather than by
the whole flood. Measured, unhandled: 4,016 unclaimed jobs, days of GPU work at 1.9 to 6.7
episodes/min, with every legitimate episode behind them in insertion order.

Both halves have an operator surface. `aion queue ls` shows depth, age and per-lane totals;
`aion queue promote --session <id>` pulls one session's jobs to the front; `aion queue drop`
sheds unclaimed rows after printing the count. Shedding leaves the episodes stored and
unenriched, which `aion queue reconcile` counts and `--re-enqueue` hands back to the queue in
the bulk lane.

The same lag is visible without touching the queue directly. `/health` and `aion status`
report queue depth per lane, the oldest unclaimed job's age, the exhausted-attempts count,
the reinforcement queue's cumulative dropped-row counter, and the p95 of intake-to-enriched
lag over a rolling window of completed jobs; `aion doctor`'s `queue-lag` check warns (never
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
cycles, and the ledger entry for the window says `failed` with the message. The loop outlives
every tick: a tick that could not finish is logged and the next one starts clean.

**Two service instances tick at once.** Each operation claims a calendar-aligned time bucket
in the ops ledger before it starts, and the claim is an insert that loses to whoever inserted
first. The instance that loses skips the window. Ticks are also jittered around the interval
so two instances started together drift apart instead of racing every time.

**A crash mid-operation.** The claim lands before the run, so the window stays claimed until
it rolls over. That is the deliberate trade: maintenance that skips a window costs one
cadence, and maintenance that reruns over a partial first pass costs whatever the operation
was halfway through.

**Diagnose.** `aion stats` has a `maintenance` section: the cycle count, and per operation
the runs, how many improved the metric they declared, how many changed nothing, how many
failed, and the last window's outcome. An operation that has never been selected says so
rather than reporting zeroes.

## Deferred gaps

**Two bounded, non-lossy artifacts, not tracked as gaps.** `ensureSession` runs before the
episode write, so a graph outage that lands between the two leaves a Session node with no
Episode attached. And a client that disconnects without a clean MCP shutdown leaves its
server-side session in the map until the 512-session cap evicts it. Neither loses data or
grows unbounded.

**A pending-vector node still has no expiry of its own.** Nothing in the graph ages one out:
it stays vectorless until a drain reaches it. That is deliberate (the marker is the absence
of the property, so there is no flag to go stale). What changed is that the drain is no
longer only the worker's startup pass: the `vector_backfill` operation reads the same parity
the doctor reports and embeds what it finds, and a parity under 0.8 on a substrate of at
least 20 vector-bearing nodes is a tier-1 condition that preempts the routine catalog.
