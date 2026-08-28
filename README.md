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
content, a rationale (which method found it, its score, and the graph path when one
applies), and a currency marker (`current` or `superseded`, with the superseding item's id
and timestamp when applicable). The pack also carries `rendered_text` (a block ready to
drop straight into agent reasoning) and metadata: the cues extracted from the query, a
per-stage timing breakdown, and a token estimate.

`as_of` asks what was true at a past date (world time). `knew_at` asks what the substrate
believed at a past date (system time). Both can be set together. An empty pack is a valid,
honest answer: nothing relevant is stored, which is not a failure.

### reflection

Stores what just happened so a later session can recall it. The payload needs at least one
of `turns`, `tool_executions`, or `observations`; `summary` and `session_id` are optional.
Credentials are redacted before anything is written, and sending the same payload twice
returns the original episode id rather than storing a duplicate.

Intake returns `{ episode_id, queued: true }` as soon as the episode is durably stored in
the graph, so the call never blocks the work it describes.

## CLI

Run through `./bin/aion <command>`, which builds the image when sources are newer than it
and then runs the command in the `aion-cli` container.

- `init`: provision the substrate (neo4j, models, schema, backbone)
- `status`: services, models, and graph counts
- `doctor`: check every substrate invariant and name what is broken
- `last`: the last MemoryPack served per session, with rationale

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
graph schema.

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
- `AION_MIN_RELEVANCE`: the relevance floor a fused item must clear to reach a pack (`0.35`)
- `AION_MCP_PORT`: the port the MCP server listens on (`8765`)

## Status

P0 through P2 are built and gated: substrate provisioning (`init`, schema migrations, the
backbone), experience capture (reflection intake: validate, redact, dedupe, store
bitemporally), and recall with the full MCP surface (four seed strategies, spreading
activation, RRF fusion, MemoryPack assembly). 643/643 tests pass; `aion doctor` runs 8
checks, all green against a live stack. The full build history, including what review
found in each phase, is in [docs/build-ledger.md](docs/build-ledger.md).

P3 and later are not yet built: the reflection extraction pipeline (entities, associations,
narratives), Hebbian edge plasticity, and maintenance passes. Their config knobs are
declared and validated but unread. Recall today serves the `episodes` and `facts` buckets
from episode, turn, and session structure; `narratives`, `preferences`, and `resonant` have
no producer yet and stay structurally absent from a pack rather than empty.
