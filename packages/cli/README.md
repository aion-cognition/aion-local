# @aion/cli

`bin/aion` runs this CLI on the host for native installs and through Compose for Docker installs.
Both use the same commands. `dist/hook-main.js` is the separate client used by Claude Code and
Codex hooks.

## Setup and use

Build the host CLI with `npm ci` and `npm run build`. Use `npm link` if the command should be on
PATH. Select the installation and generation provider at setup:

```sh
aion init --install native --provider openai
# Or: aion init --install docker --provider anthropic
aion status
aion doctor
```

Setup records the choices in `.env`. Later commands use that configuration; `aion init` also
reuses it when refreshing an existing installation. The provider needs only its own key.
Setup records an exported key when no key is saved, or offers an optional prompt on a terminal.
Without a key, capture and local embeddings remain available and hosted generation stays queued.
`--yes` skips setup prompts and does not require a key to preserve capture.

`aion help` and command `--help` use the host command catalog without starting services or
building a Docker image. Commands work from any directory through the installed PATH link.
Environment overrides affect the CLI run on either install mode; service configuration comes
from `.env`. Setup persists the selected provider and its supplied credential there.

The old `aion-native` name and `init local` / `init full` invocations remain compatibility aliases.
They do not select separate generation behavior. The recorded install profile owns dispatch.

## Boundaries

Imports `@aion/core` for substrate operations, `@aion/protocol` for wire shapes, and `@aion/mcp`
for service constants and runtime integration.

`hook/` is the exception, with a stricter rule: node builtins and its own siblings, nothing
else. It runs on the host's bare node with no install step, so one third-party import breaks
every fire on a machine that never ran `npm install`. `hook/imports.test.ts` fails on one.

## The commands

`run.ts` is the dispatch table and the source of `aion help`.

```
init        set up the selected installation and generation provider
hooks       install the Claude Code harness hooks: install | uninstall | status
status      services, models, routing, and graph counts
doctor      check every substrate invariant and name what is broken
last        the last MemoryPack served per session, with rationale
queue       inspect the reflection queue: ls | drop | promote | reconcile | index
replay      put archived experiences and the usage stream back: ls | run | usage
proposals   inspect autonomous proposals or apply a correction: ls | apply | dismiss | reopen
maintain    the maintenance catalog, and forcing one operation to run now: ls | run
unmerge     split an identity back out of the entity dedup absorbed it into: ls | apply
stats       substrate counts, queue and plasticity health, cadence, per-method pack shares
why         provenance, lineage, and open proposals for one node
timeline    one episode across the archive, the graph, the queue, and the ledger
search      direct hybrid search through the seed layer, bypassing pack assembly
source-search literal search over captured source parts
source      read a captured source or part
forget      bitemporal close of a node by id or query: nothing is deleted
unforget    retract a forget while retaining its history
unsupersede reopen a claim a supersession closed, whatever made the close
costs       API token usage and estimated cost by day and surface
logs        inspect the substrate log
uninstall   remove installation-owned components and report anything left
```

Dispatch is all `run.ts` does. Each command opens its own logger from validated config, which
keeps `loadConfig` the one reader of `AION_*` vars: a second env read in the dispatcher would
take a bad log level silently and miss the unknown-variable check.

## The shared lifecycle

`substrate.ts`. `withSubstrate` takes a command's spec, its parse function and its run
function, and owns everything around them. `--help` answers before anything opens, flags parse
and config validates before a file is touched, and `needsGraph` names the command in the
refusal when Bolt has to answer first. The driver and the database close however the command
ends, driver first, since draining work can still read and write the database. `Substrate`
opens logger, database and driver on first use, so a command that answers out of its own
catalog opens none of them.

The spec is `args.ts`. A command declares an `ArgSpec` (the command word, the usage line,
subcommands, options, how many bare arguments it takes) and `parseArgs` walks argv against
it, so a flag cannot be added to the parser and missed in the usage text, and an unknown flag
cannot pass silently the way `aion stats --help` once ran stats. Every bad invocation raises
`CliUsageError`, and the runner prints the command's usage line under the message.

## The hook subtree

`hook-main.ts` compiles to `dist/hook-main.js`, the path `~/.claude/settings.json` names. Per
fire it opens a streamable-HTTP MCP session against `http://127.0.0.1:8765/mcp`
(`AION_MCP_PORT` moves the port), makes one tool call, and deletes the session.

- `run.ts`: the entry, the fail-open wrapper, and one JSON trace line per fire.
- `events.ts`: the eight handlers, one MCP round trip at most each.
- `mcp.ts`: the client, sized for a single fire. It reads plain JSON and SSE-framed bodies.
- `transcript.ts`, `payload.ts`, `state.ts`, `options.ts`: reading the harness JSONL
  defensively, shaping tool arguments, the per-session cursor under `~/.aion/hook-state/`.
- `settings.ts`, `settings-file.ts`: what belongs in the `hooks` block of
  `~/.claude/settings.json`, and the reads, backups, and writes of that file. The install
  command goes through them; a fire never writes the settings file.
- `route-state.ts`: whether the provider `AION_GENERATION_PROVIDER` selects has its key, read
  from the environment and from the repo `.env` the compiled entry sits in. The answer goes in
  the fire's trace line and gates nothing.

Hooks belong to every install, keyed or not. A fire with no key captures as usual, and intake
stores the turn and queues its enrichment until the selected provider has a key.

Everything fails open. A hook that throws, times out, or meets a service that is not running
exits 0 with nothing on stdout, because blocking a turn over memory is worse than losing the
memory. `stop --mode instruct`, which blocks by design, is the one exception.

`hooks-cmd.ts` is the install side, and runs in the `aion` process rather than a hook one. It
owns the invocation and what the user is told. Our entries are recognized by `hook-main.js`
in the command path, so a second install replaces them rather than stacking and every other
hook survives. Inside the CLI container neither the host repo nor the host's settings is
reachable, so install prints the block to merge by hand.

## Checks

```
npx vitest run --project unit packages/cli
npx vitest run --project integration packages/cli   # needs Docker and host Ollama
npx tsc -b packages/cli
npx eslint packages/cli
```

`./bin/aion <command>` uses the recorded installation. Tests use disposable fixtures instead of
the live stores. `launcher.test.ts` executes both dispatch paths with isolated transports.
`docs/harness.md` covers the hooks.
