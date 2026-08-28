# AGENTS.md

Conventions and commands for agents working in this repo.

## Conventions

- TypeScript 5.9, strict, ESM (`NodeNext`). Every relative import ends in `.js`.
- `type`, never `interface`.
- No single-line control flow: every `if`, `for`, `while` body is a block, even one line.
- Files stay under 500 lines.
- No factory functions.
- Comments state a constraint, not a narration. No plan or task IDs in comments.
- All Cypher lives in `packages/core/src/infrastructure/graph/`. This is a review-time
  rule, not tool-enforced: no test scans for Cypher outside that directory.
- Every graph write is idempotent and bitemporal, with one deliberate exception: see
  "no node hard-deletes" below and `docs/architecture.md`'s note on access-tracking.
- No node hard-deletes, ever. Correcting or removing a fact supersedes it.
- No heuristic text machinery (regex, keyword lists) in the cognitive path: cue
  extraction, ranking, and activation are model-driven or graph-structural. Redaction is
  the deliberate exception, since secret detection is deterministic by design.

## Layout

```
packages/protocol/src/                  Zod wire schemas for recall and reflection
packages/core/src/
  index.ts                              package entrypoint
  infrastructure/config/                config schema, defaults, the AION_* registry, loader
  infrastructure/graph/                 every Cypher statement in the workspace
  infrastructure/logging/               pino wrapper
  infrastructure/providers/             Ollama client, circuit breaker, provisioning
  infrastructure/sqlite/                reflection queue, last-pack cache, ops ledger, locks
  recall/domain/                        pure: activation, fusion (RRF/MMR), pack assembly
  recall/application/                   cue extraction, seed strategies, the recall pipeline
  redaction/                            deterministic secret detection
  reflection/domain/                    pure: episode/turn shaping, content hashing, stage contract
  reflection/application/               intake (the write path), dispatch, orchestrator, worker
  reflection/application/stages/        the pipeline, in the order bootstrap.ts registers them
  session/                              identity-to-session-id resolution
packages/mcp/src/                       MCP server: tool definitions, HTTP transport
packages/cli/src/                       aion command: init, status, doctor, last
bin/aion                                host wrapper: rebuilds the image, runs the CLI container
```

## Commands

```
npm run build             # tsc -b, whole workspace
npm test                   # both vitest projects: unit, then integration
npm run test:unit          # packages/*/src/**/*.test.ts, no external services
npm run test:integration   # packages/*/src/**/*.int.test.ts, needs Docker + host Ollama
npm run test:watch         # unit project, watch mode
```

Integration tests read `AION_OLLAMA_URL`; running them on the host rather than inside the
CLI container needs it set explicitly:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

`./bin/aion <init|status|doctor|last>` runs the built CLI against the real compose stack.
Use it to exercise the actual binary, not as a test runner.

## Guard tests

- `packages/core/src/infrastructure/graph/no-hard-delete.test.ts`: scans every `.ts` file
  under `packages/` for a Cypher `DETACH DELETE` or bare `DELETE` clause (SQL's `DELETE
  FROM` and JavaScript's `delete` operator are excluded by the pattern), and fails if it
  finds one anywhere but itself. This is the only convention enforced by a repo-wide scan.
  A grep guard modeled on it would be the cheap way to enforce Cypher confinement to
  `infrastructure/graph/`, if that becomes worth codifying.

## Live-stack cautions

- Never point tests at the live `aion` compose project (the `neo4j` / `aion-mcp` /
  `aion-cli` services `./bin/aion` drives). Integration tests spin up their own throwaway
  Neo4j container per test file with a bare `docker run`
  (`infrastructure/graph/test-support/neo4j-harness.fixture.ts`) and remove it after; that
  harness is the only Neo4j integration tests may touch.
- The integration vitest project runs with `fileParallelism: false` on purpose: each
  throwaway Neo4j container asks for a 1G heap plus 512M page cache, and several booting
  at once can exceed a dev-sized Docker VM and fail on resource contention instead of on
  the code under test.
