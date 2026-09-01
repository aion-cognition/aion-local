# AGENTS.md

Conventions and commands for agents working in this repo.

## Conventions

- TypeScript 5.9, strict, ESM (`NodeNext`). Every relative import ends in `.js`.
- `type`, never `interface`. Lint enforces it
  (`@typescript-eslint/consistent-type-definitions`).
- No single-line control flow: every `if`, `for`, `while` body is a block, even one line.
  Lint enforces it (`curly: all`).
- Files stay under 500 lines. Lint enforces it (`max-lines`), off for tests and fixtures,
  where it stays a review-time rule.
- No factory functions.
- A knob is declared once: one row in `packages/core/src/infrastructure/config/knobs.ts`, as
  `leaf: [envVar, zod schema, default]` under its group. The schema tree, the defaults, and the
  AION_* registry are folded out of that table, so nothing else needs an edit. The schema
  carries the real validation (enum, range, refinement), and the decoder that reads the env
  string follows from the type of the default; a var that feeds a whole subtree names its
  decoder as a fourth element. Recapture `config-surface.json` when a knob is added, renamed,
  or retuned, and the diff is the review.
- Comments state the why or a constraint in plain register: simple tenses, no em-dashes.
  Never cite the whitepaper, the PRD, plans, phases, findings, reviews, or the build
  process; inline the reason itself. No plan or task IDs, no self-referential narration.
  Test titles describe behavior, never findings.
- Docs (README, docs/) follow the same register: no em-dashes anywhere (use period, comma,
  colon, or parentheses), plain words, front-load the verdict, one piece of evidence per
  claim. `docs/degradation.md` models the register.
- All Cypher lives in `packages/core/src/infrastructure/graph/`. This is a review-time
  rule, not tool-enforced: no test scans for Cypher outside that directory. It covers every
  statement that runs, including the assertion queries integration tests make, which belong
  in `infrastructure/graph/test-support/graph-queries.fixture.ts`. It does not cover a fake
  driver recognising a statement production code generated (`cypher.includes('MATCH …')`):
  that is a string predicate about the adapter's output, and moving it into `graph/` would
  make the adapter depend on the stage shapes it is supposed to know nothing about.
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
  infrastructure/config/                knobs.ts declares every knob; schema, defaults, and the
                                        AION_* registry derive from it; loader
  infrastructure/graph/                 every Cypher statement in the workspace
  infrastructure/logging/               pino wrapper
  infrastructure/providers/             Ollama client, circuit breaker, provisioning
  infrastructure/sqlite/                reflection queue, last-pack cache, ops ledger, locks
  recall/domain/                        pure: activation, fusion (RRF/MMR), pack assembly
  recall/application/                   cue extraction, seed strategies, the recall pipeline
  plasticity/                           reinforcement folding and the decay curve, plus the
                                        two bounded operations that apply them
  introspection/domain/                 pure: health snapshot, the tiered decision, the
                                        operation contract, time-bucketed keys
  introspection/application/            the tick loop, the catalog, one file per operation
  redaction/                            deterministic secret detection
  reflection/domain/                    pure: episode/turn shaping, content hashing, stage contract
  reflection/application/               intake (the write path), orchestrator, worker, lanes
  reflection/application/stages/        the pipeline, in the order bootstrap.ts registers them
  session/                              identity-to-session-id resolution
packages/mcp/src/                       MCP server: tool definitions, HTTP transport
packages/cli/src/                       aion command: init, status, doctor, stats, last, why,
                                        search, forget, unsupersede, queue, proposals, maintain,
                                        unmerge
bin/aion                                host wrapper: rebuilds the image, runs the CLI container
```

## Commands

```
npm run build              # tsc -b, whole workspace
npm test                   # both vitest projects: unit, then integration
npm run test:unit          # packages/*/src/**/*.test.ts, no external services
npm run test:integration   # packages/*/src/**/*.int.test.ts, needs Docker + host Ollama
npm run test:watch         # unit project, watch mode

npm run typecheck:all      # tsc -p tsconfig.tests.json: tests and fixtures included
npm run lint               # eslint .
npm run lint:fix           # eslint . --fix
npm run format             # prettier --write .
npm run format:check       # prettier --check .
```

`tsc -b` excludes `*.test.ts` and `*.fixture.ts`, so a change to a shared type compiles clean
and fails at runtime in a test. `typecheck:all` is the pass that sees them, and it is a gate:
the baseline is zero errors, so any error it reports is one this change introduced. When you
change a shared type, also run the tests that construct it.

Prettier does not format Markdown here: `.prettierignore` lists `*.md` and `docs/`, so
`format:check` says nothing about the docs. Register is a review-time rule, not a tool.

Integration tests read `AION_OLLAMA_URL`; running them on the host rather than inside the
CLI container needs it set explicitly:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

`./bin/aion <command>` runs the built CLI against the real compose stack (`aion help` lists
every command). Use it to exercise the actual binary, not as a test runner.

## Guard tests

- `packages/core/src/infrastructure/graph/no-hard-delete.test.ts`: scans every `.ts` file
  under `packages/` for a Cypher `DETACH DELETE` or bare `DELETE` clause (SQL's `DELETE
  FROM` and JavaScript's `delete` operator are excluded by the pattern), and fails if it
  finds one outside the two files it skips. Those two are itself, which has to name the
  patterns it forbids, and `test-support/neo4j-harness.fixture.ts`, which clears the test
  database between files. A test in the same file pins the skip list at exactly those two,
  so widening it takes a deliberate edit. It is the only convention enforced by a repo-wide
  scan rather than by lint: the three lint-backed conventions are marked above, and
  everything else in that list is a review-time rule.
  A grep guard modeled on this one would be the cheap way to enforce Cypher confinement to
  `infrastructure/graph/`, if that becomes worth codifying.
- `packages/core/src/infrastructure/config/config-surface.test.ts`: compares the live config
  surface against the committed `config-surface.json`, knob by knob. It covers the default
  tree, every env var with its path and kind, and the verdict the loader and the schema return
  for a fixed probe set, so a change to how the surface is produced is green only if it
  produces the same surface. A failure with no knob change means the derivation drifted.

## The gate definition

A round gates on all of these, not just the suite:

```
npm run build            # tsc -b
npm run typecheck:all    # tsc -p tsconfig.tests.json: tests and fixtures included
npm run lint             # eslint . (departures documented in eslint/README.md)
npm run format:check     # prettier --check .
npm test                 # all vitest projects; the full integration run takes about eight
                         #   minutes on this machine now that files run three abreast
```

Plus the re-exercise batteries below, and `./bin/aion doctor` green against the live stack.
The `service-freshness` doctor check warns when the running service's build sha trails the
repo HEAD: a rebuilt image reaches the container only on a recreate. After any commit that
should be live:

```
AION_BUILD_SHA="$(git rev-parse --short HEAD)" docker compose build
docker compose --profile mcp up -d
```

A bare `docker compose build` stamps the image `unstamped`: the sha reaches the image only
through that env var, which `bin/aion` exports and compose alone does not. The sha must be
the short form, because doctor compares the running stamp against `git rev-parse --short
HEAD`, so a full-length sha never matches and the service reads stale forever. Any
`./bin/aion` command also rebuilds the image, correctly stamped, when sources are newer
than it; the recreate is still a separate step, and doctor's freshness warning is the
reminder.

## The re-exercise gate

`packages/mcp/src/gate/` holds ten int test files. Seven scripted batteries, each one a
finding from the first full-system exercise round re-run against the shipped pipeline
(`bootstrap.ts`'s own stage list, live Ollama, a pooled throwaway Neo4j cleared for each
file), are split across three of them, listed below. The other seven gate one behavior each,
three of them the mode-setting batteries further down.

```
npx vitest run --project integration --reporter=verbose re-exercise-gate         # all seven
npx vitest run --project integration --reporter=verbose re-exercise-gate-recall  # 1, 2
npx vitest run --project integration --reporter=verbose re-exercise-gate-change  # 3, 4, 5
npx vitest run --project integration --reporter=verbose re-exercise-gate-write   # 6, 7
```

`--reporter=verbose` is not optional if you want the numbers: the default reporter prints a
passing test's `console.log` nowhere, and every battery reports its measurement that way.

Batteries: 1 unrelated queries come back thin or empty; 2 the paired on-topic set still hits;
3 an applied correction changes the answer; 4 the six-case contradiction set closes nothing on one
judgment alone; 5 narratives stay grounded in their session's own nodes; 6 the leaked-shape
corpus reaches no stored node; 7 a live turn enriches ahead of a bulk flood. Battery fixtures
are shared with the workstream that owns each area (`floors.fixtures.ts`,
`leaked-shapes.fixture.ts`) rather than copied.

## Live-stack cautions

- Never point tests at the live `aion` compose project (the `neo4j` / `aion-mcp` /
  `aion-cli` services `./bin/aion` drives). The integration project starts a pool of
  throwaway Neo4j containers with bare `docker run`s and removes them when the run ends
  (`infrastructure/graph/test-support/neo4j-global-setup.fixture.ts`); those containers are
  the only Neo4j integration tests may touch. Every container it starts is named
  `aion-test-neo4j-<uuid>`, so a run killed outright leaves some that are easy to find.
- Files run in parallel, as many abreast as the pool holds (default 3, sized to the Docker
  VM's memory beside the live stack; override with `TEST_NEO4J_POOL_SIZE`).
  `startNeo4jHarness()` claims a free pool container through an exclusive lease
  (`neo4j-lease.fixture.ts`), clears it, and releases it when the file ends, so concurrent
  files each hold a database of their own. Clearing drops the schema as well as the data,
  because files declare their own vector dimension and do not agree on one. Run a file
  outside the integration project and no pool is published, so the harness starts a
  container of its own instead. `startDedicatedNeo4jHarness()` asks for that container
  outright; the harness lifecycle test is the one caller that needs it, since it asserts on
  the removal the lease never performs.
- For fast single-file iteration, keep a warm container across runs:
  `eval "$(node scripts/test-neo4j.mjs start)"`. With `TEST_SHARED_NEO4J_URI` exported the
  runner boots no pool, drops to serial, and every file leases the warm container directly,
  so a run starts in seconds. `node scripts/test-neo4j.mjs stop` removes it.
- `model-reconciliation` and `routing-key-flip` live in the `integration-ollama` project,
  which runs serially after the integration group finishes. They assert on the Ollama
  daemon's resident-model list, which the whole machine shares: a concurrent file generating
  against the same model would reload it mid-eviction and fail the poll. `npm run
  test:integration` runs both projects; a bare `--project integration` filter skips them.

## Test generation routing

Integration tests that drive enrichment call `testGenerationProvider(options)`
(`infrastructure/providers/test-support/generation-provider.ts`) instead of constructing an
`OllamaProvider` directly. With `AION_ANTHROPIC_API_KEY` set and `TEST_AION_GENERATION` unset or
not `local`, generation runs on Anthropic (`claude-haiku-4-5`, override with
`AION_ANTHROPIC_MODEL`) and returns in a second or two; embedding always stays on Ollama, since
the substrate has one embedding space. With no key, or `TEST_AION_GENERATION=local`, generation
runs on qwen3:8b instead, 35 to 100 seconds an episode. vitest does not load `.env`, so export
the key before a run that should use it:

```
export AION_ANTHROPIC_API_KEY="$(grep '^AION_ANTHROPIC_API_KEY=' .env | cut -d= -f2-)"
```

A file whose subject is the local model itself (`cues.int.test.ts`, `ollama-provider.int.test.ts`)
builds its own `OllamaProvider` and ignores this switch.

`stages/supersession.int.test.ts` measures a real number this way. The recorded 0.400
precision figure came from a live-stack exercise run on
the local judge, not from this file, so re-measuring it means running the file with
`TEST_AION_GENERATION=local`. The file's own assertions (propose not close, which rows land)
hold on either model and are not what that figure describes.

`gate/supersession-precision.int.test.ts` is what sets the shipped `AION_SUPERSEDE_MODE`.
It scores the single-pass and the two-pass judge over the same 24 pairs and asserts the
shipped default matches its own measurement against a bar written before the numbers: at or
above 0.9 precision and 0.9 recall ships `unanimous`, under either bar ships `propose`. A
failure there means the judge moved, and the fix is to change the default rather than the
assertion. It also prints a separate RETRO line scoring the two-pass judge against proposals
a person already ruled on, which is a hindsight figure and never mixed into the first.

`gate/tier3-advisor-selection.int.test.ts` is the same shape for
`AION_MAINTENANCE_TIER3_MODE`. It reads 24 health snapshots the deterministic tiers all leave
idle, scores the advisor alone and the advisor with its review against the answer each case was
built with, and asserts the shipped default against a bar written before the numbers: agreement
at or above 0.9 with no invalid selection ships `act`, anything less ships `propose`.

`gate/entity-cascade-precision.int.test.ts` is the same shape for `AION_ENTITY_MERGE_MODE`. It
runs the 24-pair cascade battery pinned to `unanimous` and asserts the shipped default against
a bar written before the numbers: precision at or above 0.9 on the headline, tier 0 included,
and at or above 0.9 on the judge tier alone ships `unanimous`, under either bar ships
`propose`. `JUDGED_SAMPLE_FLOOR` (4) is the smallest judged sample the rule trusts, since tier
0's deterministic merges alone can carry the headline to 1.000 without judging anything. A
failure there means the cascade moved, and the fix is to change the knob rather than the
assertion.
