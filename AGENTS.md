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
  infrastructure/providers/             Ollama client, circuit breaker, provisioning
  infrastructure/sqlite/                reflection queue, experience archive, usage-event log,
                                        last-pack cache, ops ledger, introspection insights, locks
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
  reflection/application/stages/        the pipeline, in the order pipeline.ts's
                                        reflectionStages() registers them
  session/                              identity-to-session-id resolution
  prompts/                              every generation system prompt, one file per surface,
                                        exported as LOCAL and KEYED, forks named in
                                        fork-registry.test.ts
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
  A test in the same file pins the list at those two. `fork-registry.test.ts` beside it names
  the surfaces whose two routes read different text, and proves every other surface exports one
  constant under both names, so a keyed prompt cannot drift from its local twin unnamed.
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
job; an unchanged plist against a healthy server is a no-op. `bin/aion-native` stamps HEAD only
when `packages/*/dist` is at least as new as the tracked sources, so a pull with no build reads
`unstamped` rather than a sha the running code does not hold.

## The re-exercise gate

`packages/mcp/src/gate/` holds twelve int test files. Three of them carry seven scripted
batteries, listed below. Each battery is a finding from the first full-system exercise round,
re-run against the shipped pipeline (`bootstrap.ts`'s own stage list, live Ollama, a pooled
throwaway Neo4j cleared for each file). The other nine files gate one behavior each, four of
them the mode-setting batteries further down and one of them `judged-pair-liveness`, which is
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
  which runs serially after the integration group finishes. They assert on the Ollama
  daemon's resident-model list, which the whole machine shares: a concurrent file generating
  against the same model would reload it mid-eviction and fail the poll. `npm run
  test:integration` runs both projects; a bare `--project integration` filter skips them.
- A root that boots the service under a key unloads the local generation tags on its way up,
  and the daemon those tags live in is the whole machine's. `reconcileModels`
  (`packages/mcp/src/boot-models.ts`) unloads what a remote-routed role no longer needs. Under
  `AION_ANTHROPIC_API_KEY`, `mcp/service.int` and `cli/last.int` pull the local reflect tag out
  from under any local-route file running abreast of them, and the `integration` project runs
  files in parallel. Neither root claims anything about residency, which is why nothing there
  fails: the file that breaks is the other one. Run keyed service-boot roots in a selection of
  their own, or in the serial `integration-ollama` project where the residency roots already
  live.
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
(`infrastructure/providers/test-support/generation-provider.ts`) instead of constructing an
`OllamaProvider` directly. With `AION_ANTHROPIC_API_KEY` set and `TEST_AION_GENERATION` unset or
not `local`, generation runs on Anthropic (`claude-haiku-4-5`, override with
`AION_ANTHROPIC_MODEL`) and returns in a second or two. Embedding always stays on Ollama, since
the substrate has one embedding space. With no key, or `TEST_AION_GENERATION=local`, generation
runs on the local reflect model instead (`qwen3:4b-instruct-2507-q4_K_M` by default). That model
measured 12.2s at 1,772 input tokens and 46.8s at 12,488 on 2026-09-08; the previous default
`qwen3:8b` took 35 to 100 seconds an episode.

The key needs no export. The `integration` and `integration-ollama` projects run a setup file
(`infrastructure/config/test-support/load-env.fixture.ts`) that reads `AION_ANTHROPIC_API_KEY`
and `AION_ANTHROPIC_MODEL` from the repo `.env`. It sets whichever of the two the shell left
unset or blank. Setup files run before any test module loads, so a battery reading the key at
module scope sees the loaded value. An exported value wins over the file, and
`TEST_AION_GENERATION=local` forces the local model whatever the key says: the loader never
touches that variable. Those two keys are the only ones loaded, so a pin sitting in `.env`
cannot reroute a run. `npm run quality:extraction` loads the same two from the working
directory.

A file whose subject is the local model itself (`cues.int.test.ts`, `ollama-provider.int.test.ts`)
builds its own `OllamaProvider` and ignores this switch.

`stages/supersession.int.test.ts` measures a real number this way. The recorded 0.400
precision figure came from a live-stack exercise run on the local judge, before that route read
a judge pair of its own. It describes words the local route no longer sends.
`gate/supersession-precision.int.test.ts` scores the local judge directly. Run it with
`TEST_AION_GENERATION=local` and it reads the same 24 pairs against the small model, an hour
rather than fifteen minutes. Its assertion about the shipped default skips on that route, since
the default describes the route the service runs on. Measured 2026-09-05 on qwen3:8b, two-pass:
precision 0.800, recall 0.333. The stage file's own assertions (propose not close, which rows
land) hold on either model and are not what those figures describe.

`gate/supersession-precision.int.test.ts` is what sets the shipped `AION_SUPERSEDE_MODE`.
It scores the single-pass and the two-pass judge over the same 24 pairs. It asserts the
shipped default matches its own measurement against a bar written before the numbers: at or
above 0.9 precision and 0.9 recall ships `unanimous`, under either bar ships `propose`. A
failure there means the judge moved, and the fix is to change the default rather than the
assertion. It also prints a separate RETRO line scoring the two-pass judge against proposals
a person already ruled on. That is a hindsight figure, never mixed into the first.

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
runs the 24-pair cascade battery pinned to `unanimous`. It asserts the shipped default against
a bar written before the numbers: precision at or above 0.9 on the headline, tier 0 included,
and at or above 0.9 on the judge tier alone ships `unanimous`, under either bar ships
`propose`. `JUDGED_SAMPLE_FLOOR` (4) is the smallest judged sample the rule trusts, since tier
0's deterministic merges alone can carry the headline to 1.000 without judging anything. A
failure there means the cascade moved, and the fix is to change the knob rather than the
assertion.

`gate/keyed-close-precision.int.test.ts` is the same shape for `AION_KEYED_CLOSE_MODE`. It tells
24 designed pairs of sessions to the shipped entity and cognitive stages, pinned to `close`. It
scores every close the subject key made on its own against truth committed in the fixture.
The bar written before the numbers is 0.95 rather than 0.9, because a keyed close is the only
closure path with no second opinion behind it. At or above it ships `close`; under it ships
`judge`, where the key becomes a candidate generator for the same two-pass unanimous judge.
`KEYED_CLOSE_SAMPLE_FLOOR` (4) is the smallest number of closes the rule will ship `close` on,
half the eight cases that can produce one. The test prints recall and gates nothing on it,
since a key that matched nothing leaves the pair to the judge. A failure there means the
mechanism or the extractor moved, and the fix is to change the knob rather than the assertion.
