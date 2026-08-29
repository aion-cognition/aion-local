# Aion Local

Aion Local is a local-only cognitive memory substrate for AI coding agents. It exposes two
MCP tools, `recall` and `reflection`, backed by a Neo4j graph, a SQLite queue, and Ollama
models running on the host. Every graph write is bitemporal and idempotent: correcting a
fact supersedes the old node instead of deleting it, so nothing is ever hard-deleted. The
design follows the Aion whitepaper, adapted here from a multi-tenant service to a single
user running a single local stack.

## Quickstart

Prerequisites: Docker (with Compose), git, and Ollama running on the host at its default
port, 11434.

```
git clone <repo-url>
cd aion-local
./bin/aion init
```

`init` provisions the whole substrate: starts Neo4j, pulls and verifies the Ollama models,
applies the graph schema, creates the Member and Workspace backbone nodes, starts the MCP
server, and prints a registration command:

```
claude mcp add -s user --transport http aion http://127.0.0.1:8765/mcp
```

Run that once. Every later Claude Code session then connects with no per-session setup.
`init` is idempotent: rerun it any time and it reports what already exists instead of
failing or duplicating work.

## Tools

### recall

Searches persistent memory and returns what bears on the work at hand: past episodes, the
decisions inside them, and why they were made. Only `query` is required; optional fields
add conversation context, a token budget, and time travel.

The result is a `MemoryPack`: up to five buckets (`facts`, `episodes`, `narratives`,
`preferences`, `resonant`), each present only when it has content. Every item carries its
content, its rank across the whole pack, the absolute confidence behind its admission, a
rationale (which method found it, its score, and the graph path when one applies), and a
currency marker (`current` or `superseded`, with the superseding item's id and timestamp
when applicable). The pack also carries `rendered_text` (a block ready to drop straight
into agent reasoning) and metadata: the cues extracted from the query, a per-stage timing
breakdown, and a token estimate.

A pack says what it is short of. When cue extraction, embedding, or the graph degraded,
when spreading activation stopped on its budget, or when the calling session has episodes
that are stored but not yet enriched, `rendered_text` opens with one plain line naming all
of it (`note: degraded cue extraction (timeout); 2 recent episodes not yet enriched`), so
a client reading only the text block sees the same honesty a client reading the metadata
does.

`as_of` asks what was true at a past date (world time). `knew_at` asks what the substrate
believed at a past date (system time). Both can be set together. An empty pack is a valid,
honest answer: nothing relevant is stored, which is not a failure.

### reflection

Stores what just happened so a later session can recall it. The payload needs at least one
of `turns`, `tool_executions`, or `observations`; `summary` and `session_id` are optional.
Credentials are redacted before anything is written, and sending the same payload twice
returns the original episode id rather than storing a duplicate.

Intake returns `{ episode_id, queued: true, lane }` as soon as the episode is durably stored
in the graph, so the call never blocks the work it describes.

`lane` is the queue the episode was enqueued in, and it is not always the one the caller
asked for. Reflection takes an optional `lane: "bulk"`, which a client importing a backlog
sets so its episodes stop competing with live turns. Everything else is `interactive`, which
is claimed strictly first. An arrival-rate backstop demotes a session that pushes faster than
`AION_LANE_SESSION_ARRIVAL_MAX` episodes per `AION_LANE_ARRIVAL_WINDOW_MS`, and tightens
every session's allowance to `AION_LANE_HOT_SESSION_ARRIVAL_MAX` once arrivals across all
sessions pass `AION_LANE_GLOBAL_ARRIVAL_MAX`: a flood of fresh sessions is the shape a
per-session counter cannot see. An explicit `interactive` is a preference, not an exemption.

## CLI

Run through `./bin/aion <command>`, which builds the image when sources are newer than it
and then runs the command in the `aion-cli` container.

- `init`: provision the substrate (neo4j, models, schema, backbone)
- `status`: services, models, and graph counts
- `doctor`: check every substrate invariant and name what is broken
- `last`: the last MemoryPack served per session, with rationale
- `queue`: inspect and triage the reflection queue

```
aion queue ls [--session <id>] [--lane <l>] [--limit <n>]   # depth, age, attempts, per-lane totals
aion queue promote --session <id>                           # move a session's bulk jobs to interactive
aion queue drop --session <id> [--yes]                      # unclaimed rows only; prints the count first
aion queue reconcile [--re-enqueue --yes]                   # episodes with no ledger key and no queue row
```

`drop` and `reconcile --re-enqueue` report what they would do and stop unless `--yes` is
passed. `drop` never touches a claimed row: that job is running, and deleting it under its
worker produces exactly the orphan `reconcile` exists to repair. `aion doctor` runs the same
reconcile count as an informational check and warns past `AION_RECONCILE_WARN_THRESHOLD`.

## Architecture

```
packages/
  protocol/   Zod wire schemas for both tools (the leaf contract)
  core/       recall, reflection, session, redaction, and the infrastructure they run on
  mcp/        the MCP server: tool definitions, HTTP transport
  cli/        the aion command and compose orchestration
```

Inside `core`, four guarantees hold everywhere:

- **Bitemporal everything.** Every node carries `occurred_at`, a world-time validity
  interval, and a system-time transaction interval. Reads can pin either or both.
- **Supersession, never deletion.** Correcting a fact closes the old node's interval and
  links `(new)-[:SUPERSEDES]->(old)`; the old node stays recall-eligible under `as_of` and
  `knew_at`. A repo-wide test fails the build on any Cypher delete.
- **Idempotent writes.** Graph writes are `MERGE`s keyed on id or content hash. A retried
  or duplicated call converges on the same node instead of creating a second one.
  Episode-level dedupe uses this: resending a reflection payload resolves to the original
  episode.
- **Inference-first, not heuristic.** Cue extraction, ranking, and activation are
  model-driven or graph-structural, not regex or keyword matching. Redaction is the one
  deterministic exception: a credential leak cannot wait on a model's judgment.

See `docs/architecture.md` for the bounded contexts, the read and write pipelines, and the
graph schema. See `docs/degradation.md` for what happens when Ollama or Neo4j is down or
slow, and how each failure surfaces to the caller.

## Development

```
npm test              # both vitest projects: unit, then integration
npm run test:unit      # no external services required
npm run test:integration  # needs Docker (throwaway Neo4j per test file) and host Ollama
npm run build          # tsc -b across the workspace
```

Integration tests read `AION_OLLAMA_URL`; when running them on the host rather than in the
container, export it first:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

Every runtime knob is an `AION_*` environment variable, cataloged in
`packages/core/src/infrastructure/config/registry.ts` with typed defaults in `defaults.ts`.
A few examples:

- `AION_NEO4J_URI`: Bolt endpoint (`bolt://neo4j:7687` by default)
- `AION_VECTOR_ADMISSION_FLOOR`: the calibrated cosine an item must measure to reach a pack on its own (`0.60`)
- `AION_MCP_PORT`: the port the MCP server listens on (`8765`)

### Reflection concurrency

`AION_WORKER_COUNT` (default `1`) sets how many episodes the reflection worker claims and
runs at once, sharing one dispatch subscription and one queue claimant. Raising it alone
does not raise throughput: the recall cue model, the reflection worker, and the idle
narrative sweeper all call the same host Ollama, so extra workers just queue behind the one
model each is waiting on. Set `OLLAMA_NUM_PARALLEL` on the **host** Ollama process (not a
compose variable; Ollama runs on the host, not in a container) to raise its per-model
request concurrency alongside `AION_WORKER_COUNT`, for example:

```
OLLAMA_NUM_PARALLEL=2 ollama serve
```

See `docs/degradation.md` for the measured cost of shared-Ollama contention.

## Status

P0 through P3 are built and gated: substrate provisioning (`init`, schema migrations, the
backbone), experience capture (reflection intake: validate, redact, dedupe, store
bitemporally), recall with the full MCP surface (four seed strategies, spreading activation,
RRF fusion, MemoryPack assembly), and the reflection pipeline that turns a stored episode
into entities, associations, cognitive structure, typed relationships, supersession
judgments, and a session narrative. 1,135 unit tests pass deterministically; the 331-test
integration suite runs against a live Neo4j and host Ollama, and two tests whose assertion
turns on the reflect model's live judgment (causal-edge direction, contradiction detection)
are known to flake under Ollama's sampling rather than the pipeline under test. `aion doctor`
runs 13 checks against a live stack. The full build history, including what review found in
each phase, is in [docs/build-ledger.md](docs/build-ledger.md).

P4 and later are not yet built: Hebbian edge plasticity (recall and reflection both queue
the signals; nothing flushes them yet), context resonance, and maintenance passes. Their
config knobs are declared and validated but unread. Recall serves `facts`, `episodes`, and
`narratives`; `preferences` and `resonant` have no producer yet and stay structurally absent
from a pack rather than empty.
