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
aion proposals reopen <id>                                  # undo a dismissal, hygiene's or a person's
```

`proposals apply` takes one id at a time on purpose: applying them in bulk would reinstate
auto-supersession with an extra keystroke. Its default blade closes the judged claim and the
siblings of the same episode that name one of its subjects; `--claim-only` closes just the
claim, and `--episode` closes everything that observation produced.

An entity-merge proposal whose two names match exactly never reaches this list: `merge_auto`
merges it on its own. `aion proposals` is where a person decides the fuzzy remainder, the
pairs whose names differ, until `proposal_hygiene` ages one out: past
`AION_MAINTENANCE_HYGIENE_RESIDUE_AGE_DAYS` (or the shorter
`AION_MAINTENANCE_HYGIENE_POLLUTED_AGE_HOURS` for a proposal whose source episode was pure
tool exhaust, no conversation to judge) it dismisses the row and ledgers the class, the
reason, and the pair, so a wrong dismissal is judged from a real record. `aion proposals
reopen <id>` undoes any dismissal, hygiene's or a person's, and puts the row back in this
queue. A merge proposal one of whose entities a later merge has since absorbed waits for no
horizon at all: hygiene sweeps those at the top of every run and resolves each one with the
side that went, because a pair with a closed side has nothing left for a person to decide.
`AION_AUTO_MERGE=false` turns merge_auto off and leaves every proposal queued for a
person instead; `aion unmerge` reverses a merge `merge_auto` made, one at a time, the same
as any other entity merge.

What reaches this queue depends on `AION_SUPERSEDE_MODE`. Under the shipped `unanimous`, the
pipeline closes what two independent judgments agree on and queues the rest, so a row here is
one the second pass vetoed and the veto is its rationale. Under `propose` every judgment lands
here and nothing closes on its own.

## Supersession mode

```
AION_SUPERSEDE_MODE=unanimous    # the default: close on two agreeing judgments, queue the rest
AION_SUPERSEDE_MODE=propose      # the kill switch: queue everything, close nothing
AION_SUPERSEDE_MODE=auto         # the legacy confidence gate, superseded by unanimous
```

`unanimous` puts every affirmative contradiction judgment through a second model call that
argues the other side. The second call never sees the first one's reasoning, leads with the
presumption that both statements stay, and checks two things: whether the older claim is
actually made false, and whether the newer one is a coherent claim at all. A closure needs both
passes. A veto names which check failed and why, and that sentence is the proposal row's
rationale. The close itself takes the same path and the same blade `aion proposals apply` does,
and is stamped `supersession_unanimous_auto` so lineage never reads as though a person decided.

The default is a measurement, not a preference. `supersession-precision.int.test.ts` scores both
judges over 24 designed pairs and asserts the shipped default matches what it measures: at or
above 0.9 precision and 0.9 recall the default is `unanimous`, under either bar it is `propose`,
and the test fails loudly either way round. Measured 2026-08-30 on claude-haiku-4-5: two-pass
precision 1.000 and recall 1.000, against 0.857 and 1.000 for the single pass.

`auto` still works and is documented here only so a deployment that pinned it knows what it has.
It gates on the judge's stated confidence, which came back 0.95 on every affirmative in the same
run, so the threshold is a pass-through rather than a filter.

## Reopening a correction

```
aion unsupersede <node_id> [--yes]
```

The undo for a close, whatever made it: a wrong judgment, a family cut too wide, or an
autonomous close you disagree with. It previews what it would reopen and stops without `--yes`.

Nothing is deleted. The `SUPERSEDES` edge is kept and closed in system time, and the claim gets
its currency back, so `aion why` shows the close and the reopen both, and a `--knew-at` read
pinned before the reopen still reports the supersession the substrate held then. A forgotten
node stays forgotten: that is a separate act with its own command.

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

`aion status` prints a `lanes` section: one line per operation that acts on its own between
ticks (`merge_auto`, `supersession`, `proposal_hygiene`, `tier3`), each read as `acting` or
`off` from its own live knobs. Two states only, so the line answers "would this touch
anything right now" without a third reading to interpret.

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

Everything writes structured JSONL to two places at once: stdout, which `docker logs
aion-aion-mcp-1` reads, and one file on the data volume, `/data/logs/aion.jsonl` by default.
The service logs under the name `aion-mcp`, and every CLI run under its command's name.
`AION_LOG_LEVEL` moves the level (`debug` through `fatal`); writes are synchronous, so a
crash keeps the tail that explains it. The container's stdout copy is capped by the compose
`logging` block (10 MB × 3); the file on the volume is the uncapped durable record. The
harness hooks are the one component outside the containers; each fire appends one line to
`~/.aion/hook-state/hooks.log` on the host.

## Configuration

Every runtime knob is an `AION_*` environment variable, declared in
`packages/core/src/infrastructure/config/knobs.ts` with its type and default. `.env` is for
what an install has to decide: endpoints, models, the key, the behavior switches. Values
copied into `.env` stop following the code that calibrated them, so leave a tuning knob
alone unless a measurement says otherwise. An unknown `AION_*` variable fails the boot
loudly; a knob that once existed and was retired is ignored with no complaint.

`proposal_hygiene`'s four: `AION_MAINTENANCE_PROPOSAL_HYGIENE` (default `true`) is its kill
switch. `AION_MAINTENANCE_HYGIENE_POLLUTED_AGE_HOURS` (default `24`) is the fast horizon for
a proposal whose source episode was pure tool exhaust; `AION_MAINTENANCE_HYGIENE_RESIDUE_AGE_DAYS`
(default `14`) is the ordinary horizon for everything else. `AION_MAINTENANCE_HYGIENE_JUDGE_BATCH`
(default `5`) caps how many fuzzy entity-merge pairs the op puts through a model call in one run.

`identifier_decay` bitemporally closes an identifier-shaped entity (a commit SHA, a UUID, a
path, an agent id) once `AION_MAINTENANCE_IDENTIFIER_HALF_LIFE_DAYS` (default `7`) passes with
no fresh mention, unless it is a merge target, carries a typed-knowledge edge, or more than
`AION_MAINTENANCE_IDENTIFIER_MENTION_FLOOR` (default `5`) episodes have mentioned it.

`claim_dedup` merges a recently-extracted claim into its nearest current neighbor once a
two-pass judge unanimously calls the pair one assertion restated: the older claim survives, the
newer one's source episode folds onto it, and the newer closes with the same `SUPERSEDES`
lineage a contradiction close writes, so `aion unsupersede` reverses it like any other close.
`AION_MAINTENANCE_CLAIM_DEDUP` (default `true`) is its kill switch. `AION_MAINTENANCE_CLAIM_DEDUP_BATCH`
(default `5`) bounds pairs judged per run, since every pair costs up to two model calls.
`AION_MAINTENANCE_CLAIM_DEDUP_COSINE_FLOOR` (default `0.95`) is the nearest-neighbor floor a
pair must clear before the judge is asked at all. A pair is judged once, ever: the verdict is
ledgered under a permanent key on the unordered pair, so a re-run never pays for it twice.

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
