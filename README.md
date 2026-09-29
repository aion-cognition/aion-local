# Aion Local

Aion Local is a local-first cognitive memory substrate for AI coding agents. It exposes four
MCP tools: `recall` and `reflection` for memory, `source_search` and `source` for reading the
captured archive directly. A Neo4j graph, a SQLite queue, and an embedding model on the host
Ollama back them, with generation on one hosted provider, Anthropic or OpenAI. What one session
stores, a later session recalls, with the decisions, the reasons, and the corrections intact.

Memory here is a process, not storage. Recall constructs context instead of searching for
matches. Reflection turns raw conversation into structured knowledge in the background, and an
introspection loop maintains the graph on its own. Every write is bitemporal and idempotent:
correcting a fact supersedes the old node instead of deleting it. Nothing is ever hard-deleted,
so the substrate can answer what it believed at any point in time.
[docs/whitepaper.md](docs/whitepaper.md) explains the thinking; this page gets you running.

The substrate never leaves the machine. Generation is the one part that does: every model call
runs on the provider `AION_GENERATION_PROVIDER` selects, and that provider's API key is what turns
it on.

## Quickstart

Prerequisites: git, Node and npm, [Ollama](https://ollama.com) running on the host at its default
port, 11434, and an API key for one generation provider: `AION_ANTHROPIC_API_KEY` or
`AION_OPENAI_API_KEY`. Ollama serves the embedding model; the key is what generation runs on.
Without a key the substrate still captures, embeds and recalls, and every generation waits (see
below). The Docker installation also needs Docker with Compose; the native one runs Neo4j and the
server as host processes.

Clone this repo (or unpack the release archive), then:

```
cd aion-local
npm ci
npm run build
npm link
aion init --install native --provider openai
```

`npm link` puts `aion` on your PATH as a symlink back to this working tree. Choose the
installation (`native` or `docker`) and the provider (`anthropic` or `openai`) once; `init`
records both in `.env`, and every later command uses them. `aion init --install docker --provider
anthropic` sets up the other combination. Either provider works with either installation.

`init` provisions the whole substrate: starts Neo4j (installing and configuring it on the native
installation), pulls and verifies the embedding model, applies the graph schema, creates the
Member, Workspace and Substrate backbone nodes, starts the MCP server (a launchd job on native, a
container on Docker), and ends with a `doctor` report and a registration command. It asks for a
member name (defaulting to your git user.name). That name identifies the graph node your sessions
attach to, the person this memory belongs to. The registration command it prints at the end:

```
claude mcp add -s user --transport http aion http://127.0.0.1:8765/mcp
```

Run that once. Every later Claude Code session connects with no per-session setup.
`init` is idempotent: rerun it any time and it reports what already exists instead of
failing or duplicating work.

Check the install with `aion doctor`, which verifies every substrate invariant against the live
stack. An archive install has no git history to stamp the build with, so `doctor` reports one
service-freshness warning there; it is cosmetic. [docs/operations.md](docs/operations.md) covers
both installations and their failure remedies.

## Where generation runs

Every generation runs on the one provider `AION_GENERATION_PROVIDER` selects: `anthropic`, the
default, on `claude-haiku-4-5` (`AION_ANTHROPIC_MODEL`), or `openai` on `gpt-6-luna`
(`AION_OPENAI_MODEL`). Only that provider's key is read. There is no per-role choice: recall's
assessment call, reflection with every stage behind it, the maintenance judgments, narratives and
batched description refreshes all reach the same place. Routing resolves once at boot
(`packages/core/src/infrastructure/providers/routing.ts`) and `aion status` prints it.

Embeddings run on `snowflake-arctic-embed2` on the host Ollama under either install profile, and
are never routed: one model owns the vector space for the life of the substrate. Ollama serves
nothing else here.

**With no key.** Capture, embedding, the graph and the archive all work. Recall works too: it
serves retrieval's own ranking without the model's assessment. The pack's metadata records the
`assessment` stage as degraded (`unavailable`), and its text says it is the retrieval ranking, so
a caller reading one knows which kind of pack it is. Every generation
stays queued: the reflection worker puts a job back without spending an attempt, `aion status`
prints `routing cue=queued(<provider>) reflect=queued(<provider>)`, and `aion doctor` says the
same under `ollama-round-trip` and `hooks-route`. Put the key in `.env`, rerun `aion init`, and the
queue drains. Nothing falls back to a local model or to the other provider.

**Cost.** A daily dollar ceiling (`AION_DAILY_CEILING_USD`, $5; the older
`AION_ANTHROPIC_DAILY_CEILING_USD` still works) is held against before anything is sent, by
ordinary calls and batch submissions on either provider alike. Past it, background work queues and
recall serves retrieval's ranking, the same way a missing key reads. The selected provider's batch
API carries the background work that tolerates minutes to hours, at half price: entity-gloss
refreshes go through it today, and recall and anything else a caller is waiting on stay on
ordinary calls. `aion costs` prints the day against the ceiling and outstanding batch commitments
beside what has landed ([docs/operations.md](docs/operations.md#api-costs)). Neither provider
writes a prompt cache here, and the same file says why for each.

What else the route decides:

- **What a capture costs.** Hooks fire on every install and hand the turn to the queue. `aion
  doctor` reports what digests them as `hooks-route`. [docs/harness.md](docs/harness.md) states
  the cadence.
- **What a failed generation call costs.** The provider retries a throttled or failed answer and
  trips a circuit breaker on a bad stretch. [docs/degradation.md](docs/degradation.md) carries the
  rungs and what each of them costs.

`init` also installs the Claude Code harness hooks. The hooks turn the agent's judgment call about
when to remember into a fixed cadence: recall at session start and on a substantial prompt,
capture on compaction, stop, subagent stop, and session end.

There is one setup, whichever provider you choose. `init` settles the selected provider's key in
`.env`: a key already recorded there wins over one exported only in the shell, a key exported only
in the shell is recorded, and otherwise a terminal offers an optional prompt. An empty answer, or
an unattended `--yes`, leaves capture and local embeddings running and hosted generation queued; a
missing key is not a second mode. To add or change a key later, put it in `.env` as
`AION_ANTHROPIC_API_KEY=...` or `AION_OPENAI_API_KEY=...` and rerun `aion init`; the service
restarts with it and the queued work drains. Removing it and rerunning init puts generation back in
the queue.

`aion hooks install | uninstall | status` does the hook half on its own. `--harness codex`
points the same commands at `$CODEX_HOME/hooks.json` and the aion server block in the
`config.toml` beside it. The hook client runs on host Node from `packages/cli/dist`, which the
quickstart's `npm run build` produces on either installation. Every hook fails open: a service that is down or a payload it
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

`aion <command>` runs on the installation `init` recorded: on native it runs the built CLI on the
host, and on Docker it runs the command in the `aion-cli` container, building the image first when
sources are newer than it. `aion help` and `aion <command> --help` print the catalog and each
command's flags on the host, without starting Docker or the service.

`npm link` makes `aion` a symlink back to this working tree, so it always runs your current
checkout; a symlink of `bin/aion` into any directory on your PATH does the same. `npm unlink -g
aion-local` removes the linked one. A copying install (`npm install -g .`) does not work and says
so: the CLI orchestrates the repo it lives in.

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
- `proposals`: inspect the judged contradictions and duplicate entities the maintenance loop
  decides on its own, or apply, dismiss or reopen one as an optional correction
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
  cli/        the aion command for both installations, and the harness hook client
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

A change gates on all of those, plus the scripted re-exercise batteries and `aion doctor` green
against the live stack. `AGENTS.md` holds the full gate definition. Integration
tests read `AION_OLLAMA_URL`; when you run them on the host rather than in the container,
export it first:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

The keys need no export. An integration run reads `AION_ANTHROPIC_API_KEY`,
`AION_ANTHROPIC_MODEL`, `AION_OPENAI_API_KEY` and `AION_OPENAI_MODEL` from the repo `.env` for
whichever of them the shell left unset. Those four are the only values loaded from the file.
Which provider a run measures is not one of them: it is Anthropic unless the shell exports
`AION_GENERATION_PROVIDER=openai`.

With no key for that provider, the gate batteries skip and say so. Every floor and pinned default
they assert on was measured against a remote judge, and no other route stands in for one.

## Status

The substrate is complete and in daily use: provisioning, capture, recall with the full MCP
surface, the reflection pipeline, Hebbian reinforcement and decay, the introspection loop
scheduling thirty-two maintenance operations, generation on one hosted provider (Anthropic or
OpenAI) with local embeddings, the harness hooks, and the CLI above. Unit tests pass deterministically; the
integration suite runs against a live Neo4j and host Ollama. Engrams, described in the
whitepaper, are designed and not yet built. The `preferences` pack bucket has no producer yet
and stays structurally absent rather than empty.

## License

Apache-2.0. See [LICENSE](LICENSE).
