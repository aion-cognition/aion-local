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
- A knob is declared once: one row in its group's table under
  `packages/core/src/infrastructure/config/` (knobs.ts, or the reflection/maintenance/temporal
  knob files), as `leaf: [envVar, zod schema, default]`. The schema tree, the defaults, and the
  AION_* registry fold out of that table, so nothing else needs an edit. The schema carries the
  real validation (enum, range, refinement). The decoder that reads the env string follows from
  the type of the default; a var that feeds a whole subtree names its decoder as a fourth
  element. Recapture `config-surface.json` when a knob is added, renamed, or retuned. The diff
  is the review.
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
  infrastructure/providers/             Anthropic client and batch adapter, local embedder,
                                        circuit breaker, provisioning
  infrastructure/sqlite/                reflection queue, batch work, experience archive,
                                        usage-event log, last-pack cache, ops ledger,
                                        introspection insights, locks
  recall/domain/                        pure: activation, fusion (RRF/MMR), pack assembly
  recall/application/                   cue extraction, seed strategies, the recall pipeline
  plasticity/                           reinforcement folding and the decay curve, the two bounded
                                        operations that apply them, and the drain's one owner and
                                        its own cadence (drain.ts)
  introspection/domain/                 pure: health snapshot, the tiered decision, the
                                        operation contract, time-bucketed keys
  introspection/application/            the tick loop, the catalog, one file per operation
  redaction/                            deterministic secret detection
  reflection/domain/                    pure: episode/turn shaping, content hashing, stage contract
  reflection/application/               intake (the write path), orchestrator, worker, lanes
  reflection/application/stages/        the pipeline, in the order pipeline.ts's
                                        reflectionStages() registers them
  session/                              identity-to-session-id resolution
  prompts/                              every generation system prompt, one file per surface, one
                                        exported constant per prompt; frame.ts is the shared why
                                        the request builder puts ahead of all of them;
                                        prompt-surfaces.test.ts sweeps the directory and
                                        prompt-prefix-size.test.ts measures against the cache floor
packages/mcp/src/                       MCP server: tool definitions, HTTP transport
packages/cli/src/                       aion command: init, status, doctor, stats, last, why,
                                        timeline, search, source-search, source, forget,
                                        unforget, unsupersede, queue, replay, proposals,
                                        maintain, unmerge, costs, logs, uninstall, hooks, help
packages/cli/src/hook/                  the harness hook client: codex-rollout.ts reads the codex
                                        rollout, codex-settings.ts shapes its hooks file
bin/aion                                host wrapper: rebuilds the image, runs the CLI container
```

## Commands

```
npm run build              # tsc -b, whole workspace
npm test                   # all vitest projects: unit, then integration, then integration-ollama
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
and fails at runtime in a test. `typecheck:all` is the pass that sees them, and it is a gate.
The baseline is zero errors, so any error it reports is one this change introduced. When you
change a shared type, also run the tests that construct it.

Prettier does not format Markdown here: `.prettierignore` lists `*.md` and `docs/`, so
`format:check` says nothing about the docs. Register is a review-time rule, not a tool.

Integration tests read `AION_OLLAMA_URL`. To run them on the host rather than inside the CLI
container, set it explicitly:

```
export AION_OLLAMA_URL=http://127.0.0.1:11434
```

`./bin/aion <command>` runs the built CLI against the real compose stack (`aion help` lists
every command). Use it to exercise the actual binary, not as a test runner.

## Guard tests

- `packages/core/src/infrastructure/graph/no-hard-delete.test.ts`: scans every `.ts` file
  under `packages/` for a Cypher `DETACH DELETE` or bare `DELETE` clause, and fails if it
  finds one outside the three files it skips. The pattern excludes SQL's `DELETE FROM` and
  JavaScript's `delete` operator. Those three files are itself, which has to name the patterns
  it forbids, `test-support/neo4j-harness.fixture.ts`, which clears the test database between
  files, and `infrastructure/graph/episode-eviction.ts`, C9's reviewed exception and the only
  production module allowed to remove a node. A test in the same file pins the skip list at
  exactly those three, so widening it takes a deliberate edit. It and the prompt scan below are
  the only two conventions a repo-wide scan enforces; three more are lint-backed and marked
  above, and the rest of that list is review-time. A grep guard modeled on this one would be
  the cheap way to enforce Cypher confinement to `infrastructure/graph/`, if that becomes worth
  codifying.
- `packages/core/src/prompts/no-stray-system-prompt.test.ts`: scans every `.ts` file under
  `packages/` for an assignment to an identifier ending in `SYSTEM_PROMPT`, and fails on one
  found outside `prompts/`. It skips two files, itself and `packages/mcp/src/descriptions.ts`,
  which is what an agent reads when it picks a tool rather than text a model generates against.
  A test in the same file pins the list at those two. `prompt-surfaces.test.ts` beside it sweeps
  the directory for a prompt exported under a route-specific name, which is what a fork looked
  like from outside the file before the local generation route was removed.
- `packages/core/src/infrastructure/config/config-surface.test.ts`: compares the live config
  surface against the committed `config-surface.json`, knob by knob. It covers the default
  tree, every env var with its path and kind, and the verdict the loader and the schema return
  for a fixed probe set. A change to how the surface is produced stays green only if it
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
the short form. Doctor compares the running stamp against `git rev-parse --short HEAD`, so a
full-length sha never matches and the service reads stale forever. Any `./bin/aion` command
also rebuilds the image, correctly stamped, when sources are newer than it. The recreate is
still a separate step, and doctor's freshness warning is the reminder.

The native profile has no image, and the same commit reaches its launchd job this way:

```
npm run build && ./bin/aion-native init --install native
```

The sha rides in the job's environment, so a new one rewrites the plist and init reloads the
job; an unchanged plist against a healthy server is a no-op. `npm run build` records what it
built (`scripts/build-record.mjs`, run as `prebuild`/`postbuild`): a content digest of the inputs
the compiler read and its `.tsbuildinfo` state, written only when the build succeeded and the
source did not move under it. `bin/aion-native` stamps the job only when that record holds the
source on disk, by content rather than mtime, so an incremental build that left an entry file
untouched is recognised and a pull with no build reads `unstamped` rather than a sha the running
code does not hold. Source that differs from HEAD stamps as `<sha>-dirty-<digest>`, never as the
bare commit, and doctor compares like with like.

## The re-exercise gate

`packages/mcp/src/gate/` holds twelve int test files. Three of them carry seven scripted
batteries, listed below. Each battery is a finding from the first full-system exercise round,
re-run against the shipped pipeline (`bootstrap.ts`'s own stage list, live Ollama, a pooled
throwaway Neo4j cleared for each file). The other nine files gate one behavior each, four of
them the precision batteries further down and one of them `judged-pair-liveness`, which is
where a fresh contradicting pair has to reach the judge and the judgment has to complete.

```
npx vitest run --project integration --reporter=verbose re-exercise-gate         # all seven
npx vitest run --project integration --reporter=verbose re-exercise-gate-recall  # 1, 2
npx vitest run --project integration --reporter=verbose re-exercise-gate-change  # 3, 4, 5
npx vitest run --project integration --reporter=verbose re-exercise-gate-write   # 6, 7
```

`--reporter=verbose` is required for the numbers: the default reporter prints a passing test's
`console.log` nowhere, and every battery reports its measurement that way.

Batteries: 1 unrelated queries come back thin or empty; 2 the paired on-topic set still hits;
3 an applied correction changes the answer; 4 the six-case contradiction set closes nothing on one
judgment alone; 5 narratives stay grounded in their session's own nodes; 6 the leaked-shape
corpus reaches no stored node; 7 a live turn enriches ahead of a bulk flood. Battery fixtures
are shared with the workstream that owns each area (`floors.data.ts`,
`leaked-shapes.fixture.ts`) rather than copied.

## Live-stack cautions

- Never point tests at the live `aion` compose project (the `neo4j` / `aion-mcp` /
  `aion-cli` services `./bin/aion` drives). The integration project starts a pool of
  throwaway Neo4j containers with bare `docker run`s and removes them when the run ends
  (`infrastructure/graph/test-support/neo4j-global-setup.fixture.ts`). Those containers are
  the only Neo4j integration tests may touch. Every container it starts is named
  `aion-test-neo4j-<uuid>`, so a run killed outright leaves some that are easy to find.
- Files run in parallel, as many abreast as the pool holds (default 3, sized to the Docker
  VM's memory beside the live stack; override with `TEST_NEO4J_POOL_SIZE`).
  `startNeo4jHarness()` claims a free pool container through an exclusive lease
  (`neo4j-lease.fixture.ts`), clears it, and releases it when the file ends, so concurrent
  files each hold a database of their own. Clearing drops the schema as well as the data,
  because files declare their own vector dimension and do not agree on one. Outside the
  integration project nothing publishes a pool, so the harness starts a container of its own
  instead. `startDedicatedNeo4jHarness()` asks for that container outright; the harness
  lifecycle test is the one caller that needs it, since it asserts on the removal the lease
  never performs.
- For fast single-file iteration, keep a warm container across runs:
  `eval "$(node scripts/test-neo4j.mjs start)"`. With `TEST_SHARED_NEO4J_URI` exported the
  runner boots no pool, drops to serial, and every file leases the warm container directly,
  so a run starts in seconds. `node scripts/test-neo4j.mjs stop` removes it.
- `model-reconciliation` and `routing-key-flip` live in the `integration-ollama` project,
  which runs serially after the integration group finishes. They read the Ollama daemon's
  resident-model list, which the whole machine shares, and assert that nothing this substrate
  does disturbs it. `npm run test:integration` runs both projects; a bare `--project integration`
  filter skips them. Nothing unloads a model any more: the embedder is the only tag this program
  names, and it is the vector index.
- A rehearsal that loads fixtures, injects faults, or tears a store down starts from
  `startRehearsalSubstrate()` (`test-support/consolidation-rehearsal.fixture.ts`) rather than
  from the harness directly. It refuses before anything connects when the environment offers
  the running endpoint as a test target, then creates a container of its own through
  `startDedicatedNeo4jHarness()`, because clearing a leased container is itself a write to a
  store nobody there owns. A refused target is taken down before the caller holds a driver.

## Measuring the substrate

`npm run campaign:baseline <output directory>` reads both stores and writes a manifest and a
baseline beside each other. Nothing on that path writes: graph queries route READ, the
substrate file opens through `openReadOnlySqliteHandle` (which refuses a path holding no
substrate and creates no schema), and the output never goes back into either store.

Take the SQLite figures from a snapshot rather than the running file when the service is up.
SQLite's backup API is the supported consistent read: it copies through a reader that holds its
own transaction. Copying the database, its log and its index as three files mixes three moments.
From the host that means a throwaway container with the data volume mounted read-only:

```
docker run --rm -v aion_aion-data:/data:ro -v <out>:/out -w /app --entrypoint node \
  aion-local:latest -e "new (require('better-sqlite3'))('/data/aion.sqlite', \
  { readonly: true, fileMustExist: true }).backup('/out/live-snapshot.sqlite')"
```

Then pass `--sqlite <snapshot> --sqlite-source backup_api` with
`--sqlite-acquired-from`/`--sqlite-acquired-until`, so the manifest records that acquisition
apart from its own graph-read window. The two stores are still read at different moments, which
is what `observationKind` says; a checkpoint across both is a later obligation.

Each run writes under its own identity and refuses a path a run already took. If two runs claim
one immutable record, nothing can say which membership a comparison used.

Numbers come back through a gauge that carries the population it was counted over, or an
`unavailable` with the reason. A group whose schema is not installed reports every observation
it owes as unavailable rather than as an empty backlog, which is the difference between no work
to do and no collector.

## Test generation routing

Integration tests that drive enrichment call `testGenerationProvider(options)`
(`infrastructure/providers/test-support/generation-provider.ts`) instead of constructing a
provider directly. With `AION_ANTHROPIC_API_KEY` set, generation runs on Anthropic
(`claude-haiku-4-5`, override with `AION_ANTHROPIC_MODEL`) and returns in a second or two. With
`AION_REFLECT_PROVIDER=openai` exported and `AION_OPENAI_API_KEY` set it runs on OpenAI
(`gpt-6-luna`, override with `AION_OPENAI_MODEL`) instead, which is how a comparison is run; the
route is only ever chosen by that export.
Embedding always stays on Ollama, since the substrate has one embedding space. With no key the
provider refuses to generate with the same error the service raises: there is no second route to
fall back to. The precision gates guard themselves with their own `REMOTE_JUDGE_ABSENT` skip; the
rest of the enrichment files fail on a keyless machine, which is the honest reading, since what
they measure cannot run there.

The key needs no export. The `integration` and `integration-ollama` projects run a setup file
(`infrastructure/config/test-support/load-env.fixture.ts`) that reads `AION_ANTHROPIC_API_KEY`,
`AION_ANTHROPIC_MODEL`, `AION_OPENAI_API_KEY` and `AION_OPENAI_MODEL` from the repo `.env`. It
sets whichever of them the shell left unset or blank. Setup files run before any test module
loads, so a battery reading the key at module scope sees the loaded value. An exported value wins
over the file. Those are the only ones loaded, so a pin sitting in `.env` cannot reroute a run. `npm run quality:extraction`
loads the same two from the working directory.

A file whose subject is the embedding model itself (`ollama-provider.int.test.ts`) builds its own
`OllamaProvider` and ignores this switch.

The four precision batteries below report measurements; none of them chooses a shipped mode.
Each prints its precision against the bar it was written with and separately asserts a pinned
default, so a model scoring under 0.9 fails nothing and flips no runtime behavior into `propose`.
They are optional diagnostics for looking at how a model judges, not a qualification a model
has to pass before it is used: a provider switch does not require rerunning them, and the
embedding floors they sit on belong to the Arctic space rather than to the generation model.
What they do still gate is software correctness: corpus shape, parse and accounting, identity,
and the few assertions named below.

`gate/supersession-precision.int.test.ts` scores the single-pass and the two-pass judge over the
same 24 pairs for `AION_SUPERSEDE_MODE`. It prints the result against the 0.9 precision and
recall bar and asserts the pinned default, `unanimous`, independently of that result. It also
prints a separate RETRO line scoring the two-pass judge against proposals a person already
ruled on. That is a hindsight figure, never mixed into the first.

`gate/tier3-advisor-selection.int.test.ts` no longer works that way, and the difference is
deliberate. It reads the same 24 health snapshots the deterministic tiers leave idle and scores
the advisor against the answer each case was built with, but it prints that agreement rather
than gating on it, and `AION_MAINTENANCE_TIER3_MODE` ships `act` as a pinned default the file
asserts. What replaced the bar is the loop's own record: every model-chosen run is scored on the
metric its operation declared, and that score multiplies the next recommendation's confidence at
the acceptance gate. Two bars stay, and they are about the advisor being usable rather than being
right: it answers every case, and it never names an operation the reading says has no work. The
second model call this file used to score is deleted; it vetoed 20 of 23 recommendations
including ones the corpus calls correct.

`gate/entity-cascade-precision.int.test.ts` is the same shape for `AION_ENTITY_MERGE_MODE`. It
runs the 24-pair cascade battery pinned to `unanimous`, prints precision on the headline (tier 0
included) and on the judge tier alone against the 0.9 bar, and asserts the pinned default
independently. It keeps two real assertions: tier 0 makes no wrong deterministic merge, and at
least `JUDGED_SAMPLE_FLOOR` (4) of the designed pairs reach the judge, which checks the battery's
wiring. It counts pairs asked, never merges made: a floor on merges would be a quota on the model's
judgment.

`gate/keyed-close-precision.int.test.ts` is the same shape for `AION_KEYED_CLOSE_MODE`. It tells
24 designed pairs of sessions to the shipped entity and cognitive stages, pinned to `close`, and
scores every close the subject key made on its own against truth committed in the fixture. It
prints that precision against a 0.95 bar (a keyed close is the only closure path with no second
opinion behind it) and whether `KEYED_CLOSE_SAMPLE_FLOOR` (4) closes were made, and asserts the
pinned default, `judge`, where the key is a candidate generator for the two-pass unanimous judge.
It keeps two correctness assertions: the key closes something, and no close crosses cases.
