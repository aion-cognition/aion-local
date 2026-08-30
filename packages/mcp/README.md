# @aion/mcp

The long-lived service. One process holds one Neo4j driver, one SQLite handle, one session
cache and one cue cache for its whole life, and multiplexes every connected agent over
streamable HTTP. This package is transport and wiring; the memory operations themselves are
`@aion/core`.

## Boundaries

Imports `@aion/core`, `@aion/protocol`, `@modelcontextprotocol/sdk` and `zod`. It imports
nothing from `cli`.

Imported by `cli`, which takes three symbols (`HEALTH_PATH`, `runningInContainer`,
`USAGE_PROTOCOL`); `packages/cli/src/last.int.test.ts` also boots a real service through
`bootstrapService`. The dependency runs one way.

## The surface

`main.ts` is the container entrypoint (the `aion-mcp` service). `src/index.ts` is what `cli`
imports.

- `descriptions.ts`: tool names, titles, the two descriptions, and `USAGE_PROTOCOL`. These
  are tuned artifacts, not documentation: a tool-based memory only works if the agent calls
  it, so each description states when to invoke as much as what the tool does. Bump
  `DESCRIPTIONS_VERSION` on any edit to any string in the file. It travels in every tool
  definition's `_meta`, which is how observed cadence gets attributed to the text.
- `tools.ts`: `TOOL_DEFINITIONS` and `callTool`. The two definitions are hand-built from the
  protocol schemas. `z.toJSONSchema` converts `RecallInputSchema`, `MemoryPackSchema`,
  `ReflectionInputSchema` and `ReflectionOutputSchema` rather than restating them, so a
  client sees exactly the contract the handler enforces. `ToolBackend` is the seam between
  the transport and the two core handlers.
- `bootstrap.ts`: `bootstrapService(env)`, where core gets wired. Construction order is
  dependency order (config, log, storage, graph, backbone, provider), so a failure names the
  first thing that was actually wrong rather than a symptom two layers down. It also owns
  `reflectionStages`, the one place the enrichment pipeline's order lives.
- `service.ts`: `AionMcpService`, the HTTP surface. Binding, routing, shutdown drain, and
  which session a request belongs to.
- `session-registry.ts`, `mcp-server.ts`, `session-idle-sweeper.ts`, `http.ts`, `health.ts`:
  which sessions exist, what a tool call may do, the idle sweep, the transport primitives,
  and the `/health` body.
- `run.ts`: `runService`, signal handling, and ordered shutdown.

## Sessions

A `POST /mcp` with no `Mcp-Session-Id` header opens a session when the body is an initialize
request, and is refused otherwise. Each session gets its own transport and its own MCP
`Server`, because `Protocol.connect` takes ownership of the transport it is given. The
transport session id is the identity `SessionManager` keys a Session node on, which is what
lets many agents share one process and one substrate without sharing a memory session.

Most sessions never send the DELETE that closes them, because a standard client's `close()`
aborts its own transport locally. `SessionIdleSweeper` is the primary close path and the
DELETE hook is the fast case when a client does send one.

`GET /health` answers from in-process state and SQLite only, never Neo4j and never Ollama, so
a probe on every interval stays cheap.

## The gate

`gate/` holds the seven scripted batteries a change round is gated on, each run against
`bootstrap.ts`'s own stage list, live Ollama, and the run's throwaway Neo4j.

```
npx vitest run --project integration --reporter=verbose re-exercise-gate
```

`--reporter=verbose` is not optional if you want the numbers: the default reporter prints a
passing test's `console.log` nowhere, and every battery reports its measurement that way.
Append `-recall`, `-change` or `-write` to the filter to run them in three groups.

## Checks

```
npx vitest run --project unit packages/mcp
npx vitest run --project integration packages/mcp   # needs Docker and host Ollama
npx tsc -b packages/mcp
npx eslint packages/mcp
```
