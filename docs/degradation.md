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

### Full Ollama outage — recall

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

### Full Ollama outage — reflection

**Trigger.** Same outage, on the write path. `resolveEpisode` needs one embedding call
before any graph write happens (`packages/core/src/reflection/application/intake.ts:188-207`).

**What happens.** The embed call throws; `resolveEpisode` (`intake.ts:188-207`) wraps it in
`ReflectionNotStoredError('embed', err)` (`intake.ts:207`) before any transaction opens.
Nothing is written: no `Episode` node, and no queue row, because the row is keyed on an
episode id that was never minted (`packages/core/src/reflection/application/errors.ts:1-9`).
`toMcpError`
(`packages/mcp/src/tools.ts:105-116`) passes the error's own message through unchanged
rather than collapsing it to a class name.

**What the caller sees.** An MCP `InternalError` (-32603):
`reflection not stored: the embedding call failed (TypeError). Nothing was written and
nothing was queued; send this reflection again once the service is back.`

Re-verified live: the call failed in 614ms. `Episode` count in the graph was 0 before and
0 after (`MATCH (e:Episode) RETURN count(e)`), so the refusal is clean, not partial. This
replaces the pre-fix behavior, where the same outage surfaced as
`reflection failed (TypeError)` with no indication of cause or of what to do next.

**Diagnose.** `aion doctor`'s `ollama-round-trip` check, run before the call is attempted.
Live, the service logs the tool failure at `packages/mcp/src/tools.ts:109` (`tool call
failed`, with the error and tool name) before mapping it to the MCP error above.

**Recovers.** Not automatically. Nothing was queued, so the caller has to resend the same
reflection once Ollama is back.

### Neo4j down — recall

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

One thing the fix does not reach: `rendered_text` never carries the marker. `render()`
(`packages/core/src/recall/domain/pack.ts:198-211`) builds the text block from items alone
and never reads `degraded`; an empty selection always renders the constant
`"# Memory\n\nNo memories matched this query."` (`pack.ts:68`), whether or not a rung
fired. An agent reading only the tool's text content, not `structuredContent.metadata`,
still cannot tell an outage from an honest miss.

Re-verified live (`docker stop` on the harness Neo4j mid-service, then a recall against a
warm session): resolved in 16.6-17.6s across two runs (down from the pre-fix 62-66s, driven
by the driver-timeout fix below) with `metadata.degraded` exactly
`[{"stage":"graph","reason":"unavailable"}]` and `rendered_text` exactly the empty-pack
constant above, confirming the residual gap.

**Diagnose.** `aion doctor`'s `neo4j-bolt` check (`packages/cli/src/doctor.ts:74-85`), which
every other check depends on. Live, `selectSeeds`' error log line above names it directly.
`aion last` prints `degraded  graph: unavailable`.

**Recovers.** Automatically, no restart. `GraphConnection` holds one driver for the
process life (`packages/core/src/infrastructure/graph/connection.ts:143-193`); its pool
reconnects on its own once Neo4j answers again.

### Neo4j down — reflection

**Trigger.** Same outage, on the write path, for a session whose identity has not been
resolved to a Session node yet (a fresh MCP connection, or the process's first reflection
for that identity). `SessionManager.ensureSession` caches resolved identities in memory
(`packages/core/src/session/session-manager.ts:46-49`); a cache hit needs no graph call and
is unaffected by the outage.

**What happens.** `ensureGraphSession` issues a write inside `storeDurably`
(`intake.ts:224-238`). It fails; `isGraphUnavailable` recognizes the driver's
`ServiceUnavailable`/`SessionExpired` codes (or an unlabeled connection-acquisition
timeout) and `storeDurably` wraps it in `ReflectionNotStoredError('graph', err)`
(`intake.ts:235-236`) rather than letting the raw `Neo4jError` escape.

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
cancels it. A client-side `transport.close()` sends no MCP `DELETE`, so the server-side
session for that client stays in the session map
(`packages/mcp/src/service.ts:105-109, 284`) rather than closing. It is bounded, not
leaked: the map evicts down to `MAX_SESSIONS = 512` on every new session past the cap
(`service.ts:48, 317-324`, logged as `mcp session evicted`).

**What the caller sees.** Nothing; it disconnected. Its own in-flight promise rejects
locally (`McpError -32000 Connection closed`) once its socket is gone. Other clients are
unaffected; the service does not restart.

**Diagnose.** `GET /health` returns `{status: "ok", sessions: <n>}`
(`service.ts:203-206`); a session count that only grows across many short-lived clients
without settling points at abandoned transports rather than a leak in the handlers
themselves.

**Recovers.** Automatically. The stale session is either evicted under the 512 cap or
simply sits idle at negligible cost.

## Budgets and caps

Every knob below is `AION_*`-overridable; the catalog is
`packages/core/src/infrastructure/config/registry.ts`, typed defaults in `defaults.ts`.

| Knob | Default | Buys (raising it) | Costs (raising it) | Vs. spec |
|---|---|---|---|---|
| `AION_CUE_BUDGET_MS` (`recall.cueBudgetMs`) | 8000 | Headroom past a cold cue-model start (measured 2288ms cold vs. 558-811ms warm), so the hang guard stays a hang guard instead of firing on ordinary recalls. | A call that has actually hung blocks recall that much longer before the ladder degrades it. | PRD §14 pins 2000. Raised to 5000 in the original build, then to 8000 after a live gate rerun busted 2000 at a measured 2030ms. |
| `AION_RECALL_MAX_EPISODES` (`recall.maxEpisodes`) | 20 | Room for a graph-traversal item to survive fusion against near-tie vector hits. The checkpoint's one traversal-reached item ranked 13th: absent from the pack at 5, 8, and 12, present at 20. | A bigger `episodes` bucket before the token budget trims it; `episodes` is the pack's largest bucket. | Whitepaper Appendix E pins 5. Checked live at 5/8/12/20; only 20 passed. |
| `AION_RECALL_TOKEN_BUDGET` (`recall.tokenBudget`) | 1200 | Nothing directly; this is the actual size ceiling on a pack, downstream of every bucket cap. | A pack trimmed harder, regardless of how many items the caps above admitted. | Not flagged as a deviation. |
| `AION_MIN_RELEVANCE` (`recall.minRelevance`) | 0.35 | Keeps weak, near-random matches out of a pack. | Pushed higher, it can zero out a whole cue bucket: a 1x recent-turn cue scaled by weight can never clear 0.35 even at a perfect underlying match (`seeds.ts:52-60`). | Not flagged as a deviation. |
| `AION_RECALL_MAX_HOPS` (`recall.maxHops`) | 3 | Lets activation cross one `FOLLOWS` link between two episodes via the Session hub (`Episode-[:PARTICIPATES_IN]->Session-[:FOLLOWS]->Session-[:PARTICIPATES_IN]->Episode` is 3 hops). At 2, that path reaches only a contentless Session node. | Wider fan-out per iteration, more nodes visited before `maxNodesVisited` caps it. | Whitepaper Appendix E pins 2. |
| `contextResonance.seedLimit` / `.activationLimit` | 10 / 50 | Bounds the seed set and the co-activated set per recall, so activation's cost is predictable. | A true signal ranked past the cap is not considered at all, not degraded. | Not flagged as a deviation; matches the whitepaper's seed budget. |
| `activation.maxNodesVisited` / `.hubThreshold` | 500 / 10 | Bounds worst-case traversal cost; the hub threshold keeps one high-degree node from flooding the frontier. | A legitimate multi-hop path through a dense area can be cut before it is explored. | Not flagged as a deviation. |
| Other bucket caps: `maxFacts` / `maxNarratives` / `maxPreferences` / `maxResonant` / `vectorLimit` | 15 / 5 / 3 / 5 / 5 | Same shape as `maxEpisodes`: each decides what survives fusion for its bucket. | Same cost as `maxEpisodes`, unverified at other values: only the episode cap has a live pass/fail checkpoint behind it. `narratives`, `preferences`, and `resonant` have no producer yet (P3/P4), so their caps are inert today. | Not flagged as a deviation. |

## Deferred gaps

**Reflection does not queue through an outage, contrary to PRD §10.** The PRD says
"reflection jobs queue until service returns." They do not: `resolveEpisode` embeds before
any write transaction opens (`intake.ts:188-207`), so an inference or graph outage leaves
no `Episode` node and, because the queue row is keyed on an episode id, no queue row
either. The fix pass made the refusal honest, an explicit `ReflectionNotStoredError` naming
what to do, instead of a bare `TypeError`, but the underlying promise stays broken. Making
it true means storing the episode durably before the embedding call, which is a change to
the write path's order of operations, not to error handling, and was out of scope for this
pass.

**`rendered_text` carries no degradation signal.** `metadata.degraded` names every rung
that fired, but `render()` (`pack.ts:198-211`) never reads it: the text block an agent
drops straight into its own reasoning looks identical whether a query legitimately matched
nothing or the graph was unreachable for the whole call. Verified live in the Neo4j-down
recall re-run above. An agent (or a harness) that inspects only the tool's text content,
not `structuredContent.metadata`, still cannot tell the two apart.

**Two bounded, non-lossy artifacts, not tracked as gaps.** A reflection that fails on the
embed step still creates its Session node first, since `ensureSession` runs before the
embed call; an outage during reflection intake leaves orphan Session nodes with no Episode
attached. And a client that disconnects without a clean MCP shutdown leaves its server-side
session in the map until the 512-session cap evicts it. Neither loses data or grows
unbounded.
