# @aion/core

The substrate. All three memory paths live here: recall (the read), reflection (the write),
and introspection (maintenance on the service's own clock), plus the graph, SQLite, provider,
config and logging layers they run on. `mcp` and `cli` are thin over this package. Nothing in
here knows about HTTP, MCP, argv, or a terminal.

## Boundaries

Imports `@aion/protocol` for the wire schemas, and `neo4j-driver`, `better-sqlite3`, `pino`
and `zod`. Nothing else in the workspace.

Imported by `mcp` and `cli`, both through the barrels below.

## Layout

Every context with both pure logic and orchestration splits in two. `domain/` does no I/O,
reads no config, and holds no logger. `application/` is everything that touches the graph,
SQLite, or a model.

```
recall/          domain: activation, admission, fusion, ranking, pack assembly
                 application: cues, seed strategies, the pipeline, side effects
reflection/      domain: episode and turn shaping, content hashing, the stage contract
                 application: intake, orchestrator, stages/, worker, narratives, proposals
introspection/   domain: the health snapshot, the tiered decision, the operation contract
                 application: the tick loop, catalog.ts, one file per operation
plasticity/      domain: the Hebbian fold and the staleness curve
                 application: flush, decay, metrics
redaction/       deterministic secret detection, no domain and application split
session/         identity to session-id resolution, cached per process
infrastructure/  graph/, sqlite/, providers/, config/, logging/
```

The layering rule: `domain/` never imports `application/`; `application/` imports `domain/`
and `infrastructure/`. `reflection/domain/` is the one context the other two draw pure value
primitives from, and nothing draws back. `recall/domain/` takes `hashContent` from
`content.js` and `weightedMeanVector` from `context-vector.js`; `introspection/domain/` takes
`entity-cascade.js`'s relation checks. `infrastructure/` takes fifteen files' worth of the
same kind of primitive (name folding, claim keys, vector-input hashing, entity-extraction and
entity-reconciliation helpers, the `ReflectionContent` and `ComputedContextVector` types) and
nothing else: no application code, no I/O, no Cypher that reflection/ itself doesn't already
own.

## The public surface

`src/index.ts` re-exports seven layer barrels and names nothing itself, so a symbol's home is
the barrel beside it (`recall/index.ts`, `reflection/index.ts`, and so on). Read
`infrastructure/index.ts` first: it is the whole storage and provider surface in one file.

The barrels are pruned to what `mcp` and `cli` actually consume, not to everything a layer
defines. Adding an export is a deliberate act. Inside this package, import from the module
that owns the symbol; the deep subpath (`@aion/core/<path>.js`) exists for tests reaching a
sibling's `test-support/` fixtures and is not a production import route.

## Rules that hold everywhere in here

- All Cypher lives in `infrastructure/graph/`, including the assertion queries integration
  tests make. Review-time rule, no scan enforces it.
- No node hard-deletes. A correction supersedes.
  `infrastructure/graph/no-hard-delete.test.ts` scans every `.ts` file under `packages/` and
  fails the build on a Cypher delete outside the two files it skips.
- Every graph write is idempotent and bitemporally stamped. `graph/access-tracking.ts` is the
  one exception, and deliberately so: a repeat there is a real second access and should count
  twice.
- A knob is declared once, as one row in `infrastructure/config/knobs.ts`. The schema tree,
  the defaults and the `AION_*` registry all fold out of that table. Recapture
  `config-surface.json` when a knob is added, renamed or retuned, and let
  `config-surface.test.ts` be the diff.
- No regex or keyword machinery in the cognitive path: cue extraction, ranking and activation
  are model-driven or graph-structural. `redaction/` is the deliberate exception, because a
  credential leak cannot wait on a model's judgment.

## Checks

```
npx vitest run --project unit packages/core
npx vitest run --project integration packages/core   # needs Docker and host Ollama
npx tsc -b packages/core
npx eslint packages/core
```

Integration tests read `AION_OLLAMA_URL`; on the host, export
`AION_OLLAMA_URL=http://127.0.0.1:11434` before the run. They lease one throwaway Neo4j for
the whole run and clear it per file, so never point them at the live compose stack.

`docs/architecture.md` walks all three paths stage by stage and pins the graph schema.
`docs/degradation.md` covers what each path does when Neo4j or Ollama is down or slow.
