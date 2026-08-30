# Operating the substrate

Day-to-day operation happens through `./bin/aion`. This page carries the semantics that
matter when you run the sharper commands, plus the knobs an operator actually tunes. The
command list itself is in the top-level README; `aion <command> --help` prints each one's
flags.

## Queue triage

```
aion queue ls [--session <id>] [--lane <l>] [--limit <n>]   # depth, age, attempts, per-lane totals
aion queue promote --session <id>                           # move a session's bulk jobs to interactive
aion queue drop --session <id> [--yes]                      # unclaimed rows only; prints the count first
aion queue reconcile [--re-enqueue --yes]                   # episodes with no ledger key and no queue row
```

`drop` and `reconcile --re-enqueue` report what they would do and stop unless `--yes` is
passed. `drop` never touches a claimed row: that job is running, and deleting it under its
worker produces exactly the orphan `reconcile` exists to repair. `aion doctor` runs the same
reconcile count as an informational check and warns past `AION_RECONCILE_WARN_THRESHOLD`.

## Reviewing proposals

```
aion proposals ls [--all]                                   # open judged contradictions and merge candidates
aion proposals apply <id> [--claim-only | --episode]        # one at a time; default closes the subject family
aion proposals dismiss <id>
```

`proposals apply` takes one id at a time on purpose: applying them in bulk would reinstate
auto-supersession with an extra keystroke. Its default blade closes the judged claim and the
siblings of the same episode that name one of its subjects; `--claim-only` closes just the
claim, and `--episode` closes everything that observation produced.

An entity-merge proposal whose two names match exactly never reaches this list: `merge_auto`
merges it on its own. `aion proposals` is where a person decides the fuzzy remainder, the
pairs whose names differ. `AION_AUTO_MERGE=false` turns that off and leaves every proposal
queued for a person instead; `aion unmerge` reverses a merge `merge_auto` made, one at a
time, the same as any other entity merge.

## Forcing maintenance

```
aion maintain ls                                            # every registered operation and what it answers
aion maintain run <name>                                    # run one now, whatever the loop would have chosen
```

`maintain run` bypasses the operation's relevance score and its time-bucket claim, and nothing
else: the batch bounds, the transactions, the protected relationship set and the ledger record
all still hold. It exists because one operation's subject is not proportional. Thirteen leaking
nodes out of two thousand is a small share to a scoring function and an incident to a person,
and before this there was no way to say so.

## Unmerging entities

```
aion unmerge ls <canonical-id>                              # what one entity has absorbed
aion unmerge apply <merged-id>                              # split one of those identities back out
```

`unmerge` is the human end of entity deduplication, and it is deliberately not a maintenance
operation. A bad merge is not measurable from inside the graph: the shape after a correct merge
and after a wrong one is the same, and the only thing that separates them is a person saying the
two names were different things.

## Forgetting

```
aion forget <id | query> [--yes]
```

`forget` sets `forgotten_at` and deletes nothing. Default recall stops serving the node;
`aion search --as-of` and `--knew-at` still return it, which is what keeps the act audited.

## Logs

Everything writes structured JSONL to one file on the data volume, `/data/logs/aion.jsonl`
by default: the service under the name `aion-mcp`, and every CLI run under its command's
name. `AION_LOG_LEVEL` moves the level (`debug` through `fatal`); writes are synchronous, so
a crash keeps the tail that explains it. The harness hooks are the one component outside the
containers; each fire appends one line to `~/.aion/hook-state/hooks.log` on the host.

## Configuration

Every runtime knob is an `AION_*` environment variable, declared in
`packages/core/src/infrastructure/config/knobs.ts` with its type and default. `.env` is for
what an install has to decide: endpoints, models, the key, the behavior switches. Values
copied into `.env` stop following the code that calibrated them, so leave a tuning knob
alone unless a measurement says otherwise. An unknown `AION_*` variable fails the boot
loudly; a knob that once existed and was retired is ignored with no complaint.

## Reflection concurrency

`AION_WORKER_COUNT` (default `1`) sets how many episodes the reflection worker claims and
runs at once, on one claim loop and one queue claimant. Intake wakes that loop directly:
enqueueing a job calls the worker's `wake()`, and the SQLite row is what a restart replays
from regardless. Raising the count alone does not raise throughput: the recall cue model,
the reflection worker, and the idle narrative sweeper all call the same host Ollama, so
extra workers just queue behind the one model each is waiting on. Set `OLLAMA_NUM_PARALLEL`
on the host Ollama process (not a compose variable; Ollama runs on the host, not in a
container) to raise its per-model request concurrency alongside `AION_WORKER_COUNT`:

```
OLLAMA_NUM_PARALLEL=2 ollama serve
```

See [degradation.md](degradation.md) for the measured cost of shared-Ollama contention.
