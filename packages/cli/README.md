# @aion/cli

`bin/aion`'s implementation, and the harness hook client. Two compiled entrypoints that share
the package and nothing else: `dist/main.js` is the `aion` command, `dist/hook-main.js` is
what Claude Code runs on a hook fire.

## Boundaries

Imports `@aion/core` for every substrate read and write, `@aion/protocol` for the pack shape
`aion last` renders, and four symbols from `@aion/mcp` (`HEALTH_PATH`, `runningInContainer`,
`USAGE_PROTOCOL`, `reflectionStages`). Nothing imports this package.

`hook/` is the exception, with a stricter rule: node builtins and its own siblings, nothing
else. It runs on the host's bare node with no install step, so one third-party import breaks
every fire on a machine that never ran `npm install`. `hook/imports.test.ts` fails on one.

## The commands

`run.ts` is the dispatch table and the source of `aion help`.

```
init        provision the substrate: neo4j, models, schema, backbone
hooks       install the Claude Code harness hooks: install | uninstall | status
status      services, models, routing, and graph counts
doctor      check every substrate invariant and name what is broken
last        the last MemoryPack served per session, with rationale
queue       inspect the reflection queue: ls | drop | promote | reconcile
replay      put archived experiences back through the pipeline: ls | run
proposals   review judged contradictions and duplicate entities: ls | apply | dismiss
maintain    the maintenance catalog, and forcing one operation to run now: ls | run
unmerge     split an identity back out of the entity dedup absorbed it into: ls | apply
stats       substrate counts, queue and plasticity health, cadence, per-method pack shares
why         provenance, lineage, and open proposals for one node
timeline    one episode across the archive, the graph, the queue, and the ledger
search      direct hybrid search through the seed layer, bypassing pack assembly
forget      bitemporal close of a node by id or query: nothing is deleted
unsupersede reopen a claim a supersession closed, whatever made the close
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
- `events.ts`: the seven handlers, one MCP round trip at most each.
- `mcp.ts`: the client, sized for a single fire. It reads plain JSON and SSE-framed bodies.
- `transcript.ts`, `payload.ts`, `state.ts`, `options.ts`: reading the harness JSONL
  defensively, shaping tool arguments, the per-session cursor under `~/.aion/hook-state/`.
- `settings.ts`, `settings-file.ts`: what belongs in the `hooks` block of
  `~/.claude/settings.json`, and the reads, backups, and writes of that file. Both the
  install command and the hook client itself go through them.

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

`./bin/aion <command>` runs the built CLI against the live compose stack, to exercise the real
binary rather than as a test runner. `docs/harness.md` covers the hooks.
