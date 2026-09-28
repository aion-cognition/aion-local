# Aion Local

Aion Local is a local-first cognitive memory substrate for AI coding agents. It exposes four
MCP tools: `recall` and `reflection` for memory, `source_search` and `source` for reading the
captured archive directly. A Neo4j graph, a SQLite queue, and an embedding model on the host
Ollama back them, with generation on `claude-haiku-4-5`. What one session stores, a later session recalls, with the decisions, the
reasons, and the corrections intact.

Memory here is a process, not storage. Recall constructs context instead of searching for
matches. Reflection turns raw conversation into structured knowledge in the background, and an
introspection loop maintains the graph on its own. Every write is bitemporal and idempotent:
correcting a fact supersedes the old node instead of deleting it. Nothing is ever hard-deleted,
so the substrate can answer what it believed at any point in time.
[docs/whitepaper.md](docs/whitepaper.md) explains the thinking; this page gets you running.

The substrate never leaves the machine. Generation is the one part that does: every model call
runs on `claude-haiku-4-5`, and an API key is what turns it on.

## Quickstart

Prerequisites: Docker (with Compose), git, [Ollama](https://ollama.com) running on the host at
its default port, 11434, and an `AION_ANTHROPIC_API_KEY`. Ollama serves the embedding model;
the key is what generation runs on. Without a key the substrate still captures, embeds and
recalls, and every generation waits (see below). No `npm install`: the image build owns every
dependency.
Node and npm come into it only for the two optional pieces below, `npm link` and the
harness hooks.

Without Docker, the same substrate runs as host processes: `npm ci && npm run build`, then
`./bin/aion-native init --install native`. That command installs and configures Neo4j, brings
up the server as a launchd job, and ends with a `doctor` report.
[docs/operations.md](docs/operations.md) has that path and its failure remedies.

Clone this repo (or unpack the release archive), then:

```
cd aion-local
./bin/aion init
```

`init` provisions the whole substrate: starts Neo4j, pulls and verifies the embedding model,
applies the graph schema, creates the Member, Workspace and Substrate backbone nodes, starts
the MCP server, and prints a registration command. It asks which profile you want, and for a
member name (defaulting to your git user.name). That name identifies the graph node your
sessions attach to, the person this memory belongs to. The registration command it prints at
the end:

```
claude mcp add -s user --transport http aion http://127.0.0.1:8765/mcp
```

Run that once. Every later Claude Code session connects with no per-session setup.
`init` is idempotent: rerun it any time and it reports what already exists instead of
failing or duplicating work.

Check the install with `./bin/aion doctor`, which verifies every substrate invariant against
the live stack. An archive install has no git history to stamp the image with, so `doctor`
reports one service-freshness warning there; it is cosmetic.

## Where generation runs

Every generation runs on `claude-haiku-4-5` through the Anthropic API. There is one model and no
routing choice: recall's cue call, reflection with every stage behind it, the maintenance
judgments, and narratives all reach the same place. Routing resolves once at boot
(`packages/core/src/infrastructure/providers/routing.ts`) and `aion status` prints it.

Embeddings run on `snowflake-arctic-embed2` on the host Ollama under either install profile, and
are never routed: one model owns the vector space for the life of the substrate. Ollama serves
nothing else here.

**With no key.** Capture, embedding, the graph and the archive all work. Recall works too, on the
raw query text rather than extracted cues, and the pack says `degraded: cues/unavailable` so a
caller reading one knows which kind of pack it is. Every generation stays queued: the reflection
worker puts a job back without spending an attempt, `aion status` prints `routing cue=queued
reflect=queued`, and `aion doctor` says the same under `ollama-round-trip` and `hooks-route`. Set
a key and restart, and the queue drains. Nothing falls back to a local model.

**Cost.** A daily dollar ceiling (`AION_ANTHROPIC_DAILY_CEILING_USD`, $5) is held against before
anything is sent, by ordinary calls and batch submissions alike; past it, background work queues
and recall falls back to the raw query, the same way a missing key reads. The Message Batches path
carries the background work that tolerates minutes to hours, at half price: entity-gloss refreshes
go through it today, cues and anything a caller is waiting on stay on ordinary Messages calls.
`aion costs` prints the day against the ceiling and outstanding batch commitments beside what has
landed ([docs/operations.md](docs/operations.md#api-costs)). Prompt caching is off on every shipped
surface and the number behind that is in the same file: the API caches no prefix under 4,096
tokens, and the longest system prompt here is about 620.

What else the route decides:

- **What a capture costs.** Hooks fire on every install and hand the turn to the queue. `aion
  doctor` reports what digests them as `hooks-route`. [docs/harness.md](docs/harness.md) states
  the cadence.
- **What a failed generation call costs.** The provider retries a throttled or failed answer and
  trips a circuit breaker on a bad stretch. [docs/degradation.md](docs/degradation.md) carries the
  rungs and what each of them costs.

`init` takes one of two generation profiles and asks when you do not name one. Both install the
Claude Code harness hooks. The hooks turn the agent's judgment call about when to remember into
a fixed cadence: recall at session start and on a substantial prompt, capture on compaction,
stop, subagent stop, and session end.

- `aion init local` provisions the substrate without asking for a key. Capture, embedding and
  recall run; generation queues until the selected provider has one.
- `aion init full` asks for the key of the provider `AION_GENERATION_PROVIDER` selects
  (`anthropic` when unset, or `openai`), records it in `.env`, and generation runs.

Hooks belong to both: they fire on every install, and a capture with no key is stored and queued
rather than refused. To add a key to an existing install, put it in `.env` as
`AION_ANTHROPIC_API_KEY=...`, or `AION_OPENAI_API_KEY=...` under `AION_GENERATION_PROVIDER=openai`,
and rerun `./bin/aion init`; the service restarts with it and the queued work drains. Removing it
and rerunning init puts generation back in the queue.

`aion hooks install | uninstall | status` does the hook half on its own. `--harness codex`
points the same commands at `$CODEX_HOME/hooks.json` and the aion server block in the
`config.toml` beside it. The hook client runs on host Node from
`packages/cli/dist`, so hooks (unlike the substrate) need one host build first:
`npm ci && npm run build`. Every hook fails open: a service that is down or a payload it
cannot read exits 0 and the turn proceeds. See [docs/harness.md](docs/harness.md) for what
each hook does, what codex does differently, and the settings JSON for a manual install.

## The memory tools

**recall** searches persistent memory and returns a `MemoryPack`: facts, episodes,
narratives, standing intentions a trigger condition brought back, and resonant associations.
Each item carries its rank, confidence, rationale, and currency. The pack includes
`rendered_text`, a block ready to drop into agent reasoning, and it says what it is short of:
one plain line names the degraded stages and the not-yet-enriched episodes. `as_of` asks what
was true at a past date; `knew_at` asks what the substrate believed at one. An empty pack is a
valid, honest answer.

**reflection** stores what just happened. The payload takes conversation turns, tool
executions, and observations. Credentials are redacted before anything is written, and
resending the same payload returns the original episode instead of a duplicate. The call
returns as soon as the episode is durably stored. Enrichment runs behind it, interactive work
first and bulk imports behind that.

The other two tools, `source_search` and `source`, read the captured archive directly rather
than the graph: the same two jobs as the CLI's `source-search` and `source` commands below.

## CLI

Run through `./bin/aion <command>`, which builds the image when sources are newer than it
and then runs the command in the `aion-cli` container. `aion <command> --help` prints each
command's flags.

To run `aion` from anywhere, `npm link` once from the clone (needs Node and npm). That puts
`aion` on your PATH as a symlink back to this working tree, so it always runs your current
checkout. `npm unlink -g aion-local` removes it. A copying install (`npm install -g .`)
does not work and says so: the CLI orchestrates the repo it lives in.

- `init`: provision the substrate (neo4j, models, schema, backbone)
- `hooks`: install, remove, or inspect the harness hooks, for Claude Code or Codex
- `status`: services, models, routing, and graph counts
- `costs [--days N]`: metered API tokens and estimated dollars by UTC day and calling surface
- `doctor`: check every substrate invariant and name what is broken
- `stats`: everything status shows, plus cadence, per-method pack shares, generation by route,
  the recall self-probe rates, and the maintenance loop's record
- `last`: the last MemoryPack served per session, with rationale
- `why`: provenance, lineage, and open proposals for one node
- `search`: direct hybrid search through the seed layer, bypassing pack assembly
- `source-search`: literal text against the captured archive, not the seed layer
- `source`: the captured parts behind one source id, turn id, or part address
- `forget`: bitemporal close of a node, by id or by query
- `unforget`: take back a forget; the statement chain keeps both and the node serves again
- `unsupersede`: reopen a claim a supersession closed, whatever made the close
- `queue`: inspect and triage the reflection queue
- `replay`: put archived experiences back through the pipeline, and the usage stream back on top
- `proposals`: review judged contradictions and duplicate entities
- `maintain`: the maintenance catalog, and forcing one operation to run now
- `unmerge`: split an identity back out of the entity dedup absorbed it into
- `timeline`: one episode across the archive, the graph, the queue, and the ledger
- `logs`: tail the substrate's own log file, with the path it read printed first
- `uninstall`: remove what init put on this machine, and say what it left

The commands with teeth make you say so. `queue drop`, `queue reconcile --re-enqueue`,
`forget`, `unforget` and `unsupersede` preview what they would do and stop without `--yes`. `proposals`, `maintain`, and `unmerge` act only through an
explicit `apply` or `run` subcommand. `replay run` guards harder: it refuses to write to the
shipped substrate at all unless both `--live` and `--yes` are passed, since a replay
re-entering the pipeline inflates counters a live read counts as real observations. Their full
semantics, the logging layout, and the knobs an operator tunes are in
[docs/operations.md](docs/operations.md).

## Architecture

```
packages/
  protocol/   Zod wire schemas for both tools (the leaf contract)
  core/       recall, reflection, introspection, and the infrastructure they run on
  mcp/        the MCP server: tool definitions, HTTP transport, session multiplexing
  cli/        the aion command, compose orchestration, and the harness hook client
```

Each package carries its own README with its boundaries and public surface. Four guarantees
hold everywhere in `core`: every node is bitemporally stamped, corrections supersede instead
of deleting (a repo-wide test fails the build on any Cypher delete), graph writes are
idempotent, and the cognitive path is inference-first with no keyword machinery. Redaction
is the one deterministic exception, because a credential leak cannot wait on a model's
judgment.

Where to read deeper:

- [docs/whitepaper.md](docs/whitepaper.md): what this is and why it is built this way
- [docs/architecture.md](docs/architecture.md): the bounded contexts, pipelines, and graph schema
- [docs/operations.md](docs/operations.md): running it day to day
- [docs/degradation.md](docs/degradation.md): what happens when Ollama or Neo4j is down or slow
- [docs/harness.md](docs/harness.md): the Claude Code and Codex hooks, and the two cadence profiles
- [AGENTS.md](AGENTS.md): conventions and the gate, for anyone (or any agent) changing the code

## Development

```
npm ci
npm test                  # three vitest projects: unit, then integration, then integration-ollama
npm run test:unit         # no external services required
npm run test:integration  # needs Docker (one throwaway Neo4j per run) and host Ollama
npm run build             # tsc -b across the workspace
npm run typecheck:all     # tsc over tests and fixtures too, which tsc -b excludes
npm run lint              # eslint .
npm run format:check      # prettier --check .
```

A change gates on all of those, plus the scripted re-exercise batteries and `./bin/aion
doctor` green against the live stack. `AGENTS.md` holds the full gate definition. Integration
tests read `AION_OLLAMA_URL`; when you run them on the host rather than in the container,
export it first:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

The Anthropic key needs no export. An integration run reads `AION_ANTHROPIC_API_KEY` and
`AION_ANTHROPIC_MODEL` from the repo `.env` for whichever of the two the shell left unset, so
a host run measures the same remote judge the service routes to. Those two keys are the only
values loaded from the file.

With no key anywhere, the gate batteries skip and say so. The reflect role would route to the
local instruct model. Every floor and pinned default they assert on was measured against the
remote judge, so the numbers would describe a judge the service does not run.
`TEST_AION_GENERATION=local` forces that local route on purpose and skips them the same way.
The supersession battery is the one exception: it reads a judge pair written for the local
model, so it scores either route, and only its assertion about the shipped default stays keyed.

## Status

The substrate is complete and in daily use: provisioning, capture, recall with the full MCP
surface, the reflection pipeline, Hebbian reinforcement and decay, the introspection loop
scheduling thirty-one maintenance operations, per-role Anthropic routing with model
reconciliation, the harness hooks, and the CLI above. Unit tests pass deterministically; the
integration suite runs against a live Neo4j and host Ollama. Engrams, described in the
whitepaper, are designed and not yet built. The `preferences` pack bucket has no producer yet
and stays structurally absent rather than empty.

## License

Apache-2.0. See [LICENSE](LICENSE).
