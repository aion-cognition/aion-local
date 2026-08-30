# Aion Local

Aion Local is a local-first cognitive memory substrate for AI coding agents. It exposes two
MCP tools, `recall` and `reflection`, backed by a Neo4j graph, a SQLite queue, and Ollama
models running on the host. Agents that use it remember: what a session stored, a later
session recalls, with the decisions, the reasons, and the corrections intact.

Memory here is a process, not storage. Recall constructs context instead of searching for
matches, reflection turns raw conversation into structured knowledge in the background, and
an introspection loop maintains the graph on its own. Every write is bitemporal and
idempotent: correcting a fact supersedes the old node instead of deleting it, so nothing is
ever hard-deleted and the substrate can answer what it believed at any point in time.
[docs/whitepaper.md](docs/whitepaper.md) explains the thinking; this page gets you running.

The substrate never leaves the machine. Generation is the one part that can: set
`AION_ANTHROPIC_API_KEY` and cue extraction, reflection, and narratives route to
`claude-haiku-4-5` instead of the local instruct model. Embeddings stay local either way,
because the vector space is the substrate.

## Quickstart

Prerequisites: Docker (with Compose), git, and [Ollama](https://ollama.com) running on the
host at its default port, 11434. No `npm install`: the image build owns every dependency.
Node and npm come into it only for the two optional pieces below, `npm link` and the
harness hooks.

Clone this repo, then:

```
cd aion-local
./bin/aion init
```

`init` provisions the whole substrate: starts Neo4j, pulls and verifies the Ollama models,
applies the graph schema, creates the Member and Workspace backbone nodes, starts the MCP
server, and prints a registration command. Along the way it asks which profile you want,
and for a member name (defaulting to your git user.name): that names the graph node your
sessions attach to... the person this memory belongs to. The registration command it
prints at the end:

```
claude mcp add -s user --transport http aion http://127.0.0.1:8765/mcp
```

Run that once. Every later Claude Code session then connects with no per-session setup.
`init` is idempotent: rerun it any time and it reports what already exists instead of
failing or duplicating work.

Check the install with `./bin/aion doctor`, which verifies every substrate invariant against
the live stack and names anything broken.

## Profiles

`init` takes one of two profiles, and asks for it when you do not name one.

- `aion init local` provisions the substrate and nothing else. Generation runs on Ollama, and
  the agent decides for itself when to call recall and reflection.
- `aion init full` also asks for an Anthropic key and installs the Claude Code harness hooks,
  which turn that judgment call into a fixed cadence: recall at session start and on a
  substantial prompt, capture on compaction, stop, subagent stop, and session end. The two
  halves pair on purpose, since the hooks push enough small capture work to be worth routing
  to Haiku.

There is no key step before init: `full` asks for the key and records it in `.env`. To add
one to an existing `local` install, put it in `.env` as `AION_ANTHROPIC_API_KEY=...` and
rerun `./bin/aion init`; the service restarts with the key and routing follows it. Removing
it from `.env` and rerunning init routes everything back to local models the same way.

`aion hooks install | uninstall | status` does the hook half on its own. The hook client
runs on host Node from `packages/cli/dist`, so hooks (unlike the substrate) need one host
build first: `npm ci && npm run build`. Every hook fails open: a service that is down or a
payload it cannot read exits 0 and the turn proceeds. See [docs/harness.md](docs/harness.md)
for what each hook does and the settings JSON for a manual install.

## The two tools

**recall** searches persistent memory and returns a `MemoryPack`: facts, episodes,
narratives, and resonant associations, each item carrying its rank, confidence, rationale,
and currency. The pack includes `rendered_text`, a block ready to drop into agent reasoning,
and it says what it is short of: degraded stages and not-yet-enriched episodes are named in
one plain line. `as_of` asks what was true at a past date; `knew_at` asks what the substrate
believed at one. An empty pack is a valid, honest answer.

**reflection** stores what just happened. The payload takes conversation turns, tool
executions, and observations; credentials are redacted before anything is written, and
resending the same payload returns the original episode instead of a duplicate. The call
returns as soon as the episode is durably stored... enrichment runs behind it, interactive
work first, bulk imports behind that.

## CLI

Run through `./bin/aion <command>`, which builds the image when sources are newer than it
and then runs the command in the `aion-cli` container. `aion <command> --help` prints each
command's flags.

To run `aion` from anywhere, `npm link` once from the clone (needs Node and npm). That puts
`aion` on your PATH as a symlink back to this working tree, so it always runs your current
checkout. `npm unlink -g aion-local` removes it. A copying install (`npm install -g .`)
does not work and says so: the CLI orchestrates the repo it lives in.

- `init`: provision the substrate (neo4j, models, schema, backbone)
- `hooks`: install, remove, or inspect the Claude Code harness hooks
- `status`: services, models, routing, and graph counts
- `doctor`: check every substrate invariant and name what is broken
- `stats`: everything status shows, plus per-method pack shares, cadence, and plasticity
- `last`: the last MemoryPack served per session, with rationale
- `why`: provenance, lineage, and open proposals for one node
- `search`: direct hybrid search through the seed layer, bypassing pack assembly
- `forget`: bitemporal close of a node, by id or by query
- `unsupersede`: reopen a claim a supersession closed, whatever made the close
- `queue`: inspect and triage the reflection queue
- `proposals`: review judged contradictions and duplicate entities
- `maintain`: the maintenance catalog, and forcing one operation to run now
- `unmerge`: split an identity back out of the entity dedup absorbed it into

The commands with teeth make you say so: `queue drop`, `queue reconcile --re-enqueue`,
`forget`, and `unsupersede` preview what they would do and stop without `--yes`, and
`proposals`, `maintain`, and `unmerge` act only through an explicit `apply` or `run`
subcommand. Their full
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
- [docs/harness.md](docs/harness.md): the Claude Code hooks and the two cadence profiles
- [AGENTS.md](AGENTS.md): conventions and the gate, for anyone (or any agent) changing the code

## Development

```
npm ci
npm test                  # both vitest projects: unit, then integration
npm run test:unit         # no external services required
npm run test:integration  # needs Docker (one throwaway Neo4j per run) and host Ollama
npm run build             # tsc -b across the workspace
npm run typecheck:all     # tsc over tests and fixtures too, which tsc -b excludes
npm run lint              # eslint .
npm run format:check      # prettier --check .
```

A change gates on all of those, plus the scripted re-exercise batteries and `./bin/aion
doctor` green against the live stack. `AGENTS.md` holds the full gate definition. Integration
tests read `AION_OLLAMA_URL`; when running them on the host rather than in the container,
export it first:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

## Status

The substrate is complete and in daily use: provisioning, capture, recall with the full MCP
surface, the reflection pipeline, Hebbian reinforcement and decay, the introspection loop
scheduling sixteen maintenance operations, per-role Anthropic routing with model
reconciliation, the harness hooks, and the CLI above. 1,617 unit tests pass deterministically;
the integration suite runs against a live Neo4j and host Ollama. Engrams, described in the
whitepaper, are designed and not yet built, and the `preferences` pack bucket has no producer
yet and stays structurally absent rather than empty.

## License

Apache-2.0. See [LICENSE](LICENSE).
