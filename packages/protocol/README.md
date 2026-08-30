# @aion/protocol

The wire contract for the two MCP tools, written as zod schemas. Every type here is
`z.infer` of a schema, and the JSON Schema a client reads is derived from the same object by
`z.toJSONSchema` in `packages/mcp/src/tools.ts`. One definition of the wire, three consumers
of it, so the schema a handler parses and the schema a client sees cannot drift.

## Boundaries

Imports `zod` and nothing else, from the workspace or outside it. This is the leaf.

Imported by `core` (recall and reflection parse their payloads against these), `mcp` (tool
definitions and the invalid-params path), and `cli` (`aion last` renders a stored pack).

No I/O of any kind: no driver, no database, no model, no config, no logger. A schema states
the shape and the reason for it. Where a value comes from belongs to `core`.

## The surface

Five files, all re-exported from `src/index.ts`.

- `common.ts`: `IsoTimestampSchema` (date-only or full datetime with offset), `CurrencySchema`
  (`current` or `superseded`), `SupersededBySchema` (the lineage pointer and its timestamp).
- `recall-input.ts`: `RecallInputSchema`. `query` is the only required field. `context`,
  `budget`, `session_id`, `as_of` and `knew_at` are optional; `as_of` is the world-time read
  mode and `knew_at` the system-time one.
- `recall-output.ts`: `MemoryPackSchema` and everything under it, including
  `MemoryPackItemSchema`, `RationaleSchema`, `AdmittedBySchema`, `CueSchema` and
  `MemoryPackMetadataSchema`. `RecallOutput` is `MemoryPack`. Also `MEMORY_PACK_BUCKETS` and
  `packBuckets`, the one function in the package: it reads a pack's five optional buckets as
  five arrays, so a typed consumer indexes them without an `undefined` check at every site.
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

Four unit files, one per schema module. They are the contract's own tests: what a schema
accepts, what it rejects, and what the rejection says. The JSON Schema conversion is covered
by `packages/mcp/src/tools.test.ts`, because that is where the conversion happens.
