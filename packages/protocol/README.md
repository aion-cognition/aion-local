# @aion/protocol

The wire contract for the four MCP tools (`recall`, `reflection`, `source_search`, `source`),
written as zod schemas. Every type here is
`z.infer` of a schema, and the JSON Schema a client reads is derived from the same object by
`z.toJSONSchema` in `packages/mcp/src/tools.ts`. One definition of the wire, three consumers
of it, so the schema a handler parses and the schema a client sees cannot drift.

## Boundaries

Imports `zod` and nothing else, from the workspace or outside it. This is the leaf.

Imported by `core` (every tool handler parses its payload against these), `mcp` (tool
definitions and the invalid-params path), and `cli` (`aion last` renders a stored pack).

No I/O of any kind: no driver, no database, no model, no config, no logger. A schema states
the shape and the reason for it. Where a value comes from belongs to `core`.

## The surface

Nine files, all re-exported from `src/index.ts`.

- `common.ts`: `IsoTimestampSchema` (date-only or full datetime with offset), `CurrencySchema`
  (`current` or `superseded`), `SupersededBySchema` (the lineage pointer and its timestamp).
- `recall-input.ts`: `RecallInputSchema`. `query` is the only required field. `context`,
  `budget`, `session_id`, `as_of`, `knew_at` and `reset_delivery_suppression` are optional;
  `as_of` is the world-time read mode and `knew_at` the system-time one.
- `recall-output.ts`: `MemoryPackSchema` and everything under it, including
  `MemoryPackItemSchema`, `RationaleSchema`, `AdmittedBySchema`, `CueSchema`,
  `DegradationSchema`, `AssessmentReportSchema` and `MemoryPackMetadataSchema`. `RecallOutput` is `MemoryPack`. Also `MEMORY_PACK_BUCKETS` and
  `packBuckets`, the one function in the package: it reads a pack's six optional buckets as
  six arrays, so a typed consumer indexes them without an `undefined` check at every site.
- `recall-result.ts`: `RecallResultSchema`, the pack or a `RecallRefusalSchema`. A read outside
  the substrate's coverage is refused rather than answered with an empty pack, and `status`
  appears only on the refusal, so the pack's own shape is unchanged.
- `history-coverage.ts`: the coverage contract a time-traveled read is judged against: its
  version, the fields it covers, and the gap and limitation vocabulary a refusal names.
- `standing.ts`: `StandingSchema`, the standing kind, attribution and confirmation a pack item
  carries.
- `source-search.ts`: the two read-only archive tools, `SourceSearchInputSchema` and
  `SourceInputSchema`, with the hit and part shapes they answer in.
- `reflection-input.ts`: `ReflectionInputSchema`, refined so at least one of `turns`,
  `tool_executions` or `observations` carries an entry. `ReflectionLaneSchema` is the
  `interactive` or `bulk` service class.
- `reflection-output.ts`: `ReflectionOutputSchema`. `queued` is `z.literal(true)`, since
  intake never reports synchronous completion.

## Conventions that hold here

- Every object is `z.strictObject`. An unknown key is a rejection, not a silent
  pass-through.
- Wire keys are snake_case and stay that way. The lint naming rule is off for object
  properties for exactly this reason.
- A closed enum only where the vocabulary really is closed. `RecallMethodSchema` and
  `AdmissionRuleSchema` are enums because every consumer branches on them; `role` and
  `status` stay plain strings, so a legitimate value nobody pinned cannot be rejected.
- A present bucket is never empty. `memoryPackBucket` carries `.min(1)`, which puts the
  omit-rather-than-empty rule in the schema instead of in a convention.
- A new field arrives optional, so an ack or a stored pack from an older build still parses.
  `pending_ahead` and `admitted_by` are both there for that reason.

## Checks

```
npx vitest run --project unit packages/protocol
npx tsc -b packages/protocol
npx eslint packages/protocol
```

Five unit files. `common.ts`, `recall-result.ts`, `standing.ts` and `source-search.ts` have no
file of their own and are exercised through the modules and handlers that use them. Each file is the contract's own test: what a schema accepts,
what it rejects, and what the rejection says. The JSON Schema conversion is covered
by `packages/mcp/src/tools.test.ts`, because that is where the conversion happens.
