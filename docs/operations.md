# Operating the substrate

Day-to-day operation happens through `./bin/aion`. This page carries the semantics behind the
sharper commands and the knobs an operator tunes. The command list is in the top-level README;
`aion <command> --help` prints each one's flags.

## Install profiles

Two substrates, one substrate code. `AION_INSTALL_PROFILE` says which one this install runs on,
`aion init` records it, and `aion doctor` and `aion status` read it back so they check the right
thing without being told again.

**Where the files go is settled before the profile is.** The knob table's path defaults
(`/data`, `/data/aion.sqlite`, `/data/logs/aion.jsonl`) are container paths. Every command opens
a log file before it does anything else, so a process running on a host resolves them against
the machine first: `~/.aion` and the two paths under it, created on demand. Host context decides
that rather than the profile, so a bare `node packages/cli/dist/main.js` gets it too.
`AION_DATA_DIR` overrides both. `aion init` prints the resolved root on its first line.

| | `docker` (default) | `native` |
|---|---|---|
| Neo4j | the `neo4j` compose service | a server on the host, installed by init if it is missing |
| MCP server | the `aion-mcp` compose service | a launchd job, `com.aion.mcp` |
| CLI | `./bin/aion` (runs in `aion-cli`) | `./bin/aion-native` (host node, sources `.env`) |
| Both stores | the `aion_aion-data` and `aion_aion-neo4j` volumes | directories under `~/.aion` and Neo4j's own data directory |
| Ollama | on the host either way, reached at `host.docker.internal` | on the host, reached at `127.0.0.1` |

Either way, one command brings it up:

```
./bin/aion init              # docker
./bin/aion-native init --install native
```

`init` is idempotent on both. A re-run against a healthy install reports what is already there
and changes nothing: it recreates no container, bounces no launchd job, and rewrites no
configuration file.

The flag was `--profile` for one release and is now `--install`, because `aion init full --profile
native` put two different questions under one word. The old spelling still works and is not
advertised.

The flag chooses a profile once; it does not switch one. `--install docker` on a native install is
refused. The two profiles keep their stores in different places, so moving between them means
dropping both and initializing again. `--install native` on a docker-shaped config is the
conversion rather than a switch, since `docker` is the code default and a recorded default cannot
be told from nobody having chosen.

`.env.example` ships the three storage paths at the compose volume (`AION_DATA_DIR=/data`,
`AION_SQLITE_PATH`, `AION_LOG_FILE`), and `bin/aion-native` sources `.env` into every run, so a
host that copied the template carries them. Only `init --install native` converts them. Every
other command refuses by name and prints the ways through: run that init, take the three lines
out of `.env` and let each run resolve its own paths under `~/.aion`, or, on a host that really
does keep a disk at `/data`, name a directory under it (`AION_DATA_DIR=/data/aion`). The rule is
those three literal values rather than a probe of the machine, which is what makes it the same
answer everywhere.

### Bringing up the native profile

Prerequisites: [Ollama](https://ollama.com) running on the host, and a host build, because the
server and the CLI run from `packages/*/dist` rather than from an image.

```
npm ci && npm run build
./bin/aion-native init --install native
```

That one command does all of it, in order:

1. Records the profile and its five addresses in `.env` (`AION_INSTALL_PROFILE`,
   `AION_NEO4J_URI`, `AION_OLLAMA_URL`, `AION_DATA_DIR`, `AION_SQLITE_PATH`, `AION_LOG_FILE`).
   An address you set yourself is kept rather than converted, and init says which it kept.
2. Generates the Neo4j password into `.env` if there is not one there already.
3. Brings up Neo4j. A server that already answers is left alone. Otherwise: `brew install neo4j`
   if it is not installed, the matching graph-data-science jar fetched and checked against a
   digest recorded in `packages/cli/src/gds-releases.ts`, the substrate's settings written into
   `neo4j.conf` (the two `gds.*` procedure lines, heap 512m/1G, pagecache 512m, transaction-log
   retention `1 days 256M`, Bolt on loopback), the initial password set, and the service started.
4. Pulls and verifies the Ollama models the routing needs.
5. Applies the graph schema, creates the Member, Workspace and Substrate
   backbone nodes, and records the substrate's birth.
6. Writes `~/Library/LaunchAgents/com.aion.mcp.plist`, loads it with `launchctl bootstrap`, and
   waits for `/health`. The job carries `KeepAlive`, `RunAtLoad`, and `ExitTimeOut` 20 seconds,
   which is the drain the compose service had as `stop_grace_period`.
7. Records what it installed in `install-manifest.json` under the data root, which is what
   `aion uninstall` reads to tell what it put there from what was already there.
8. Prints the `aion doctor` report, which is where the coverage contract and the Ollama tuning
   flags are reported.

Then register the server with your harness, which `init` prints at the end, and the install is
done.

**What the launchd job does not do.** It reads `.env` as it was when init ran, because a launchd
job inherits almost nothing and nothing in this build loads `.env` on the host. After editing
`.env`, run init again (which rewrites and reloads the job) or
`launchctl kickstart -k gui/$(id -u)/com.aion.mcp` if the file has not changed. Its
`StandardOutPath` is `/dev/null`: the service's own logger writes the durable JSONL, and nothing
rotates a launchd file. Its `StandardErrorPath` catches a failure that happens before the logger
opens.

**Where init stops, and what to run.** Every step that changes the machine names the command that
finishes it by hand. These are the ones worth knowing in advance:

| Refusal | What to run |
|---|---|
| no Neo4j and no Homebrew | install Homebrew, or install Neo4j and `export NEO4J_HOME` to its directory |
| `brew install neo4j` failed | the same command, with brew's own error in front of you |
| no measured plugin digest for the installed server's series | download the matching graph-data-science jar into the plugins directory yourself, or record its digest in `gds-releases.ts`; the refusal prints the URL |
| the plugin download did not match its digest | nothing was installed and the file was deleted; check the network before retrying |
| the server refused the password in `.env` | put the server's real password in `AION_NEO4J_PASSWORD`, or stop it and run `neo4j-admin dbms set-initial-password` |
| Bolt never answered | `neo4j console` in the foreground, and the server log the refusal names |
| `launchctl` could not load the job | the three `launchctl` commands the refusal prints |
| the job loaded and `/health` never answered | the two log files and the `launchctl print` the refusal names |

**The server version.** `compose.yaml` pins the pairing the substrate was measured against, Neo4j
`2026.07.x` with graph-data-science `2026.07.0`. A native install takes whatever Neo4j it finds or
Homebrew installs, and pairs the plugin to it. `aion doctor` reports which you have. A matched
pair on a later series is a warning, since nobody has run the procedure census on it. A
mismatched pair is a failure, because the plugin is compiled against the kernel it ships beside.

## API costs

Run `aion costs [--days N]` to group billed API responses by UTC day and calling surface.
The default window includes today and the preceding six days. Each row reports the model, the rate
card it billed on, call count, input and output tokens, thinking tokens, cache-write and cache-read
tokens, the cache-read share of that group's input tokens, usage-error count, and estimated
dollars.

A row's rate is `standard` or `batch`. Batched requests bill at half the ordinary rate for the
same tokens, so the discount is in the dollars and never in the counts: the token columns are what
the model read and wrote either way, and halving them would misreport every reading that is not
about money. Rate cards group separately, so a batched answer cannot inherit the ordinary price.

Each batched answer is recorded once, under the remote request it came from (`<batch id>:<work
key>`). A settlement pass reads an ended batch again until its rows are terminal, and without that
identity one paid answer would be charged once per reading. An answer the substrate discards as
stale is charged the same as one it applies: paid is paid, and a bill that counted only the useful
answers would report the batch lane as cheaper than it is by the amount of the waste.

The thinking column is a share of the output column, not an addition to it. The API bills
reasoning as output, so a total that sums the two counts it twice. It says how much of the output
bill was the model reasoning before it answered, which is the number that moves when
`AION_ANTHROPIC_THINKING_BUDGET_TOKENS` changes. Only surfaces that ask to reason spend it:
today that is `tier3_advisor` and `symbiosis_bridge`. Measured 2026-09-13 against Haiku 4.5, one
tier-3 advisor call read 774 input tokens and wrote 916 output, 794 of which were reasoning.
Not every response reports the breakdown. Where one carried no reasoning share, the row stores
the input and output totals it did report and leaves that share out, because zero is what a call
that reasoned for nothing spent and the response did not say that. A group holding such a call
reads `N+unknown`, and one where no call reported a share reads `unavailable`.

Unknown models are marked `unpriced`; their charges are never counted as zero. A model with no
price still reports its cache share, and a group that spent no input tokens reads `no-input`.

The append-only SQLite `api_calls` ledger records successful HTTP responses, including answers
whose text fails JSON parsing and needs another paid call. Failed HTTP requests have no usage
row. `unlabeled` exposes callers that omit a surface label.

Missing or invalid usage produces a row with zero placeholder counters and `usage_error=invalid_usage`.
The error log says `API usage parse failed; billed token counts are unknown` without including response content.
`aion costs` counts these failures, adds `unknown charges` to its known subtotal, and prints
`unavailable` for the cache share of every group that carries one. Groups whose usage parsed
completely still report their share. The whole-window cache-effectiveness line stays unavailable,
because one unknown row leaves the window's denominator unknown.

A failed ledger write logs `API usage write failed` without retrying the paid generation.

Estimates use the provider price table dated 2026-09-06. For Haiku 4.5, rates per million
tokens are $1 input, $5 output, $1.25 cache write, and $0.10 cache read. The cache-effectiveness
line divides read tokens by all input tokens, including newly written and uncached tokens.
Each group's cache share uses the same denominator.

| Control | Default | Effect |
|---|---|---|
| `AION_ANTHROPIC_DAILY_CEILING_USD` | `5` | Dollars of generation one UTC day may commit, shared by ordinary Messages calls and batch submissions. Consulted before dispatch, never after. |
| `AION_ANTHROPIC_PROMPT_CACHE` | `true` | Allows the marker on a system prefix that reaches the API's 4,096-token floor. No shipped surface does, so no shipped call carries it; the provider decides per call rather than marking unconditionally. `false` switches the marker off whatever the length. |
| `AION_CUE_CACHE_TTL_MINUTES` | `30` | Reuses successful cue results in this process for identical generation requests. `0` disables it. The cache holds at most 256 entries. |

### The daily ceiling

Every dispatch holds against the day before it is sent. The hold is a conservative maximum, priced
from the prompt going out (three characters per token, under the four the docs estimate) and the
call's own `max_tokens`; when the answer lands, what it actually cost replaces the hold. The
reservations are rows in `generation_spend`, so two callers in one process, two processes, and one
process across a restart all read the same committed total, and a batch submitted before a restart
is still money committed after it. A hold nobody comes back to keeps counting at its maximum:
unknown is not free.

A day that cannot cover the next dispatch refuses it as generation being unavailable, the same
type a substrate with no key answers with. Background work goes back on the queue without spending
an attempt, a batch submission is not sent and its work stays queued, and recall falls back to the
raw query text. Nothing retries against a spent ceiling, because nothing a retry does clears it: a
new UTC day or a higher number does.

`aion costs` prints the day against the ceiling, with what is still in flight beside it. A model
the price table does not carry cannot be held against a dollar figure at all; such a call is
dispatched and counted, and that line says how many there were rather than reading them as free.

The extraction floor, `AION_REFLECTION_MIN_EXTRACTION_CHARS`, is owned by the separate
hardening change and is not present on this branch. `AION_NARRATIVE_MIN_NEW_EPISODES` is
deferred and is not a supported setting. Neither should be set before its implementation lands.

### Batched generation

Background work that tolerates minutes to hours goes through the Message Batches API at half the
ordinary rate. Cues and anything a caller is waiting on stay on ordinary Messages calls: a batch
takes up to 24 hours, which is not a latency budget.

The adapter is `packages/core/src/infrastructure/providers/batch-adapter.ts`, and what is owed
lives in the `batch_work` table. Four rules hold it:

- Submission is not completion. The remote identity is written down before anything is counted
  as done, and a crash between the API accepting a batch and that write costs a duplicate batch
  rather than an answer nobody can find.
- Results are consumed by `custom_id`, never by position. The API returns them unordered.
- Every answer is revalidated against the substrate before it is applied. Hours passed, and the
  pair a judgment is about may have merged, been superseded, or been forgotten. A stale answer is
  discarded and recorded as discarded.
- No remote job holds the publication guard. A handler takes its own publication when the answer
  is in hand.

Success, error, cancellation and expiry are all handled, and only the first is terminal:
cancelled, expired and errored work goes back on the queue, because the question was never
answered. A reset partitions old answers away by substrate identity, so a batch submitted before
it can land afterwards and be recognized as belonging to a store that no longer exists.

The `batch_settlement` maintenance operation is the pump: it consumes what has landed, then
submits what is owed. `aion costs` prints outstanding batch commitments beside the bill, because a
submitted batch is spend that has not been charged yet.

Its cadence is the introspection engine's, not a timer of its own and not a promise of fifteen
minutes. The engine wakes every `AION_MAINTENANCE_TICK_MINUTES` (15 by default) and runs **one**
operation, chosen from the whole catalog by tier, urgency and waiting time. This one carries a
standing relevance of 0.15 and no gauge in the health snapshot, so it reaches the threshold on
starvation rather than on demand, and several ticks can pass between its turns. The `quarter-hour`
bucket is a ceiling on how often it may be selected, not a floor on how often it is. What that
costs is latency on an answer already hours old, which is the reason this work was batched.

`description_freshness` is the producer. It nominates entity glosses that fell behind their
mentions, builds each request with the same prompt and result schema the inline call used, and
writes it to `batch_work`; the pump sends them and hands each answer back to the surface's own
handler. The handler re-reads the entity, refuses an answer whose gloss or baseline moved while
the batch was out, and applies the rest through the same guarded write, which is the last word on
whether a description was refreshed. Foreground cues stay on Messages. A surface that moves its
own judgment off the hot path registers its handler in `catalog.ts` beside that one.

### Prompt caching

Haiku 4.5 caches no prefix shorter than 4,096 tokens. A `cache_control` marker on a shorter one
is accepted and ignored, which reads as cached in the request and as uncached on the bill, so the
provider attaches it only where the prefix reaches the floor.

Nothing reaches it. `packages/core/src/prompts/prompt-prefix-size.test.ts` measures all 36 shipped
system prompts on every run: the longest is `supersession-review:KEYED` at 2,491 characters,
roughly 620 tokens, against a floor of about 16,384 characters. That test fails if a prompt grows
past the floor, which is how the decision gets revisited. No prompt is padded to reach it: a
prefix written to be long is text the model reads on every call that nobody wrote for a reason.

The floor itself is measured rather than taken from the documentation.
`anthropic-cache.int.test.ts` sends a 4,315-token probe prefix twice against the live API and
reads the usage fields back: the prefix is written once and read back on the second call, and the
uncached input is 12 tokens a call. The same file sends a short prefix twice and reads zero
creation and zero read tokens, which is the state every shipped surface is in.

`aion costs` reads `cache_creation_input_tokens` and `cache_read_input_tokens` off every billed
response, so the day a surface does grow a real shared prefix the evidence is already there.
[Anthropic's cache documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
defines the minimum and the token accounting.

One thing to watch if a prefix ever does qualify: in `system_prompt` mode the schema is part of
the prefix, so a surface that builds its schema per call has a prefix that changes per call.
Semantic relationships, the tier-3 advisor and cognitive restatement build theirs that way, and
entity merge judgment and consolidation synthesis take a caller's. A changing eligible prefix
pays the cache write every time and reads it back never.

The CLI reported these cache-effectiveness lines:

```text
before, four control calls:
cache effectiveness: 0 / 31680 input tokens (0.0%)
after, four controls plus twelve production samples:
cache effectiveness: 15818 / 39474 input tokens (40.1%)
```

The populations differ. The dollar comparison above uses only matched controls, and these
test measurements do not establish a saving for ordinary daily usage.

## Queue triage

```
aion queue ls [--session <id>] [--lane <l>] [--limit <n>]   # depth, age, attempts, per-lane totals
aion queue promote --session <id>                           # move a session's bulk jobs to interactive
aion queue drop --session <id> [--yes]                      # unclaimed rows only; prints the count first
aion queue reconcile [--re-enqueue --yes]                   # episodes with no ledger key and no queue row
aion queue index [--limit <n>]                              # drain the archive-index rows intake wrote
```

`drop` and `reconcile --re-enqueue` report what they would do and stop unless `--yes` is
passed. `drop` never touches a claimed row: that job is running, and deleting it under its
worker produces exactly the orphan `reconcile` exists to repair. `aion doctor` runs the same
reconcile count as an informational check and warns past `AION_RECONCILE_WARN_THRESHOLD`.

`--job-type <integrate | attach_vectors | source_index>` narrows `ls`, `drop` and `promote` to
one job type; `reconcile` and `index` do not take it. `drop` and `promote` default to `integrate`
when it is omitted, so a plain `drop` leaves the other two alone and reports how many it skipped.
Pass the type to drop those too. `promote` refuses `source_index` outright, since the index
drainer claims those rows by job type rather than by lane.

An acceptance writes three rows: the `integrate` job the reflection worker runs, the
`attach_vectors` job that owes the episode's embedding, and the `source_index` job the index
drainer owns. `ls` counts each apart, because one embed call a source is not the backlog a
caller asking how far behind its turn is wants reported to it. `pending_ahead` on a reflection
ack counts `integrate` rows alone for the same reason.

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

Only an entity-merge pair the dedup cascade's two judge passes split on reaches this list. A
pair both passes agree on is merged during reflection. The spellings one identity key cannot
tell apart (`re-mark` against `remark`, an identity already answering to the other's name as an
alias) are merged with no model call at all, by the cascade's tier 0 during reflection and by
`merge_auto` sweeping the whole graph on the hour.

`aion proposals` is where a person decides the residue first, ahead of `proposal_resolution`
deciding it on the hour (below) and of `proposal_hygiene` ageing one out. Past
`AION_MAINTENANCE_HYGIENE_RESIDUE_AGE_DAYS` (or the shorter
`AION_MAINTENANCE_HYGIENE_POLLUTED_AGE_HOURS` for a proposal whose source episode was pure
tool exhaust, no conversation to judge) hygiene dismisses the row and ledgers the class, the
reason, and the pair, so a wrong dismissal is judged from a real record.

A merge proposal one of whose entities a later merge has since absorbed waits for no horizon at
all: hygiene sweeps those at the top of every run and resolves each one with the side that went,
because a pair with a closed side has nothing left for a person to decide.
`AION_AUTO_MERGE=false` turns the `merge_auto` sweep off, leaving the duplicate spellings in
the graph for the next reflection to catch. `aion unmerge` reverses any entity merge one at a
time (below).

What reaches the entity half of this queue depends on `AION_ENTITY_MERGE_MODE`. Under the
shipped `unanimous` only the split pairs land here; under `propose` the pairs both passes agreed
on land here too and nothing merges at tier 3.

The contradiction half answers to `AION_SUPERSEDE_MODE`. Under the shipped `unanimous`, the
pipeline closes what two independent judgments agree on and queues the rest, so a row here is
one the second pass vetoed and the veto is its rationale. Under `propose` every judgment lands
here and nothing closes on its own.

## Deciding proposals without a person

```
AION_PROPOSAL_RESOLUTION=true    # the default: the loop decides open proposals on their merits
AION_PROPOSAL_RESOLUTION=false   # the kill switch: both queues wait for a person
AION_RESOLUTION_BATCH=10         # open rows one run decides, oldest first across both queues
```

The `proposal_resolution` operation runs on the hour and takes the oldest open rows of both
queues. It reads more than the pass that filed a row was given: the pair, each claim's subject
family with the description the substrate holds for each subject now, when each statement was
observed, and the session each one came from. A merge pair gets the dedup cascade's own evidence
plus each side's one-hop neighbourhood.

Every call runs at temperature 0, so a judge re-asked the filing question returns the filing
answer. The wider reading is what lets a second look reach a different one.

The same two passes then decide. Both affirm and the row is applied through the path
`aion proposals apply` takes, at the same default blade and the same relatedness floor, stamped
`supersession_introspector_resolution` so lineage never reads as though a person decided.
Anything else dismisses the row. Either way the verdict and both passes' reasons go to the ops
ledger under `introspection:resolution:<table>:<id>`. A model call that throws or comes back
unusable decides nothing, and the row waits for the next run.

The commands that reverse a person's decision reverse these too: `aion unsupersede` reopens a
close, `aion unmerge` splits a merge back out, `aion proposals reopen` puts a dismissed row back
in the queue. `proposal_hygiene` stays behind this as the staleness backstop, ageing out a row
resolution keeps failing on.

## Supersession mode

```
AION_SUPERSEDE_MODE=unanimous    # the default: close on two agreeing judgments, queue the rest
AION_SUPERSEDE_MODE=propose      # the kill switch: queue everything, close nothing
AION_SUPERSEDE_MODE=auto         # the confidence gate the unanimous judge replaced
```

`unanimous` puts every affirmative contradiction judgment through a second model call that
argues the other side. The second call never sees the first one's reasoning and leads with the
presumption that both statements stay. It checks whether the older claim is actually made false,
and whether the newer one is a coherent claim at all.

A closure needs both passes. A veto names which check failed and why, and that sentence is the
proposal row's rationale. The close itself takes the same path and the same blade
`aion proposals apply` does, and is stamped `supersession_unanimous_auto` so lineage never reads
as though a person decided.

The default is a measurement, not a preference. `supersession-precision.int.test.ts` scores both
judges over 24 designed pairs and asserts the shipped default matches what it measures: at or
above 0.9 precision and 0.9 recall the default is `unanimous`, under either bar it is `propose`,
and the test fails loudly either way round. Measured 2026-08-30 on claude-haiku-4-5: two-pass
precision 1.000 and recall 1.000, against 0.857 and 1.000 for the single pass.

`auto` still works and is documented here only so a deployment that pinned it knows what it has.
It gates on the judge's stated confidence, which came back 0.95 on every affirmative in the same
run, so the threshold is a pass-through rather than a filter.

## Subject-keyed closure

```
AION_KEYED_CLOSE_MODE=off     # the kill switch: skip the keyed lookup entirely
AION_KEYED_CLOSE_MODE=judge   # the default: route a keyed candidate into the same two-pass
                               # unanimous judge AION_SUPERSEDE_MODE uses
AION_KEYED_CLOSE_MODE=close   # the mechanical close, made in the writing transaction
```

Independent of `AION_SUPERSEDE_MODE`: the keyed lookup runs inside a different stage's write,
so it needs a kill switch of its own. `close` ships only once its own battery clears a bar set
ahead of the measurement: precision at or above 0.95 over the 24-case corpus, on at least four
mechanical closes; short of either it ships `judge`. `keyed-close-precision.int.test.ts`
asserts the shipped value against what it measures, in both directions.

Measured 2026-09-01 on claude-haiku-4-5 with `snowflake-arctic-embed2` embeddings, 24 pairs
of sessions through the shipped extraction stages: 2 mechanical closes, precision 1.000,
recall 0.250. Recall falls short of the bar `close` needs, so this ships `judge`.

## Entity merge mode

```
AION_ENTITY_MERGE_MODE=unanimous  # the default: merge on two agreeing judgments, queue the rest
AION_ENTITY_MERGE_MODE=propose    # the kill switch: queue every judged pair, merge none of them
```

The same shape one tier down, over identities rather than claims. The dedup cascade nominates a
pair from the name vectors and from shared episodes, then measures what the two share. It puts
the facts to two calls: one asks whether one referent explains both records, the second argues
that something separates them. Under `unanimous` a pair both passes agree on merges, with its
provenance and a decision record `aion unmerge` reads back. Under `propose` both passes still
run and the pair goes to `aion proposals` instead, so the reasoning survives a deployment that
wants a person in the loop.

Tier 0 ignores this knob. Two names that reach one key once separators are stripped, or an
identity already answering to the other's name as an alias, merge with no model call, so there
is no judgment for a mode over judgments to gate. `AION_AUTO_MERGE=false` is the switch for that
tier's hourly sweep.

The default is a measurement. `entity-cascade-precision.int.test.ts` builds 24 designed pairs
into a real graph, runs the shipped cascade over each, and asserts the shipped default matches
what it measures: at or above 0.9 auto-merge precision the default is `unanimous`, under it
`propose`, and the test fails loudly either way round. Measured 2026-09-01 on claude-haiku-4-5
with `snowflake-arctic-embed2` embeddings: TP 8, FP 0, FN 4, TN 12, precision 1.000, recall
0.667. Every miss was a pair the second pass split and the cascade queued, never a wrong merge.
Precision held at 1.000 across three runs; recall moved between 0.583 and 0.667 and gates
nothing.

## Reopening a correction

```
aion unsupersede <node_id> [--yes]
```

The undo for a close, whatever made it: a wrong judgment, a family cut too wide, or an
autonomous close you disagree with. It previews what it would reopen and stops without `--yes`.

It deletes nothing. The `SUPERSEDES` edge is kept and closed in system time, and the claim gets
its currency back. `aion why` then shows the close and the reopen both, and a `--knew-at` read
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
ticks (`merge_auto`, `entity_dedup`, `supersession`, `keyed_close`, `proposal_resolution`,
`proposal_hygiene`, `claim_dedup`, `tier3`), each read as `acting` or `off` from its own live
knobs. Two states only, so the line answers "would this touch anything right now" without a
third reading to interpret.

### The strategic tier

```
AION_MAINTENANCE_TIER3=true                    # the kill switch: off skips the consultation
AION_MAINTENANCE_TIER3_MODE=act                # act runs the recommendation; propose only logs it
AION_MAINTENANCE_TIER3_ACCEPTANCE_FLOOR=0.3    # what confidence x effectiveness has to clear
AION_MAINTENANCE_TIER3_INSIGHT_COUNT=8         # lessons from recent runs carried into the prompt
```

A cycle the deterministic tiers leave idle asks the model for one operation. `act` runs what it
names through the same bucket claim, batch bound, ledger row and scoring path a deterministic
selection takes, so a model-chosen run is an ordinary run and `aion stats` scores it like one.

What keeps that safe is the scoring rather than a second opinion. Confidence is multiplied by the
operation's own effectiveness before anything runs, so a recommendation for an operation whose
runs have stopped moving their metric is downgraded within a few cycles. An operation nothing has
scored reads at a neutral 0.5 prior, which is what lets a fresh substrate act at all. Two
operations are denied whatever the reading says: `episode_evict` and `redaction_residue_purge`,
the two writes no command puts back.

Every consultation writes one ledger row under `tier3:<cycle>`, carrying what was asked, what was
named, the raw and blended confidence, the gate's verdict, and what ran. Read them with
`aion logs` or straight out of `ops_ledger` when a recommendation looks wrong.

Turn the mode to `propose` to watch it without letting it act. The advisor still runs and still
costs its call; nothing it names is executed.

## Replaying the archive

```
aion replay ls                                    # archived experiences, usage events, by pipeline version
aion replay run [--all | --stale] [--live --yes]  # re-enters reflection for the selected experiences
aion replay usage [--live --yes]                  # re-applies access, reinforcement, decay events
```

`run` re-enters every reflection stage for the experiences it selects: the archive rather than a
live transport, so a prompt or extraction change is re-derived from what the substrate was told
instead of migrated in place.

`usage` is the second half. It re-applies the access, reinforcement and decay events the usage
stream recorded, on a graph `run` already rebuilt, in that order, since those events name nodes
and edges the pipeline has to write first.

Neither writes to the shipped substrate (the default `AION_SQLITE_PATH` or a managed
`AION_NEO4J_URI`) unless `--live --yes` are both passed. Re-entering the pipeline inflates two
counters that record real observations rather than converge on one value (the MENTIONS salience
bump and the co-occurrence edge count), and a replay's clock also feeds identifier decay. That is
why the target is a scratch substrate by default.

`--stale` is the default selection, everything archived under some other pipeline version;
`--all` replays every experience regardless of version, and `--episode`/`--session` narrow
further. `--limit` and `--batch` bound one run.

A replay is an import through the current producers. Every experience re-enters the same stages a
live capture does, so a claim it re-derives is written by the writer that writes one today and is
recorded with the same evidence. What it preserves is the occurrence: the archive row carries the
episode's own `occurred_at` and the provenance it arrived with, and the re-entered pipeline stamps
world time from those rather than from the replay's clock.

## Reading a captured source

```
aion source <id | source:kind:ordinal> [--limit <n>] [--cursor <c>] [--json]
```

`source` prints the parts behind one source id, one turn id, or one part address, from the archive
rather than from the graph. It answers after an eviction has taken the projection away, which is
the case it exists for: the records outlive the nodes.

## Searching captured text

```
aion source-search <query> [--limit <n>] [--cursor <c>] [--as-of <ts>] [--knew-at <ts>] [--json]
```

`source-search` finds a literal phrase in the archive rather than the seed layer `aion search`
reads: it answers whether the phrase was said, whether or not anything was ever extracted from it
or its graph projection still exists. A refusal or a bad request exits non-zero, so a script never
reads "cannot search here" as "no match".

## Unmerging entities

```
aion unmerge ls <canonical-id>                              # what one entity has absorbed
aion unmerge apply <merged-id>                              # split one of those identities back out
```

`unmerge` is the human end of entity deduplication, and it is deliberately not a maintenance
operation. A bad merge is not measurable from inside the graph. The shape after a correct merge
and after a wrong one is the same, and the only thing that separates them is a person saying the
two names were different things. `apply` prints the tier that made the merge and the reasons it
recorded, so the reversal names the evidence that was wrong rather than only the node.

## Forgetting

```
aion forget <id | query> [--yes]
aion unforget <node_id> [--yes]
```

`forget` sets `forgotten_at` and deletes nothing. Default recall stops serving the node;
`aion search --as-of` and `--knew-at` still return it, which is what keeps the act audited.

Both go through the publication coordinator, so each act leaves a receipt and, for a node the
records hold as a source, a statement in that source's own append-only chain. `unforget` drops
the stamp and adds the reversal after the forget rather than erasing it: a `knew_at` read from
before the reversal still finds the substrate believing the node was gone.

It is not `aion unsupersede`. That reopens a close and leaves a forget standing; this drops a
forget and leaves a supersession standing.

## Standing intentions

A Goal or a Plan comes back on its own, without being asked for. Recall reads the open ones
after the second pass and serves the ones this moment matches, in an `intentions` bucket of
their own. A moment matches when the entity the intention is about is in play, when the date its
episode named has passed, or when this situation resembles the one it was formed in. Provenance
decides the bucket rather than the label, so a Goal the query itself found still answers in
`facts`.

```
AION_RECALL_INTENTIONS=true                # the default: an intention can come back on a trigger
AION_RECALL_INTENTIONS=false               # the kill switch: no intention comes back on a trigger
AION_RECALL_INTENTION_SITUATION_FLOOR=0.5  # the cosine a situation match has to clear
AION_RECALL_MAX_INTENTIONS=3               # how many the bucket may hold
```

Off restores the pack exactly as it was before intentions had triggers. The situation floor is
borrowed from `contextSearchThreshold` rather than measured, so treat it as a starting value;
the entity and temporal triggers do not read it. Nothing here spends a model call.

An intention is dated at write: `AION_INTENTION_HORIZON_DAYS` (default `30`) past its own
episode's clock is when it stops standing and starts reading as expired, down-ranked and
labeled, never dropped.

`intention_upkeep` is the second half. Once a day it closes the Goals and Plans a whole further
horizon past that, so what it takes is stale rather than merely expired: sixty days at the
default. The close is an ordinary bitemporal close stamped with the operation's name, so
`aion unsupersede` reopens one and a ledger row per close records which ones it took.

`AION_MAINTENANCE_INTENTION_UPKEEP` (default `true`) is the kill switch, and
`AION_MAINTENANCE_INTENTION_UPKEEP_BATCH` (default `50`) bounds one run, higher than the
model-calling batches because this operation asks nothing.

## Lifecycle events

The substrate records its own life events as memory. Five of them exist: an init that created
the backbone, an init that recorded the graph schema version on a substrate that already existed,
a replay that re-derived something, a boot that unloaded a model routing no longer needs, and a
question `curiosity` filed (below). Each goes through intake as an observation on the bulk lane,
carrying the numbers that describe it (member name, profile; replay counts and pipeline version;
which model left memory).

They are ordinary episodes, so recall serves them, `aion search` finds them, and `aion forget`
removes one. All of them chain in one standing session, `aion-system`, which hangs off the
Substrate node rather than off the Member: nobody typed these, and they are the substrate's own
history rather than a conversation.

```
aion search "substrate initialized"        # the birth event, and every init since
```

## Curiosity

`curiosity` is the one operation that adds to memory rather than tidying it. Once a day it
takes the entities the substrate keeps meeting and cannot describe (a gloss a correction
retired, or one written at the first mention and never re-derived while five or more mentions
piled up), drafts one question about each, and files it as a Goal marked `origin_kind:
substrate`. The Goal is keyed to the entity, so recall serves the question back in the
`intentions` bucket above the next time that entity comes up, rather than at a moment nobody
can answer it.

```
aion search "why does it keep coming up"   # the questions filed so far
```

Each question is an ordinary episode plus an ordinary intention, so everything that reaches
one reaches these: `aion forget` removes a question, `aion unsupersede` reopens one a later
intention replaced, and `intention_upkeep` closes one nobody answered a horizon after it
expired. The entity carries a `curiosity_asked_at` stamp and is never asked about twice, even
after its description comes back.

`AION_MAINTENANCE_CURIOSITY` (default `true`) is the kill switch: off, no question is drafted
and the ones already filed stand until they are answered or age out. `AION_CURIOSITY_BATCH`
(default `2`) is how many questions one run files. Two is deliberately the lowest batch in the
catalog: every question interrupts a later session on its own, and a substrate that asks faster
than it is answered is nagging.

## The recall self-probe

`recall_probe` is how the substrate measures its own memory. Once a day it takes a few
experiences it was told about more than a day ago, asks for each of them back in the words they
arrived in, and scores whether the pack answered. An answer is the episode itself, something
extraction pulled out of it, or the narrative that compressed it. The rate is a lifetime total,
so it fills in a few questions a day.

The same run reads the other half of the question. Of the items still on record as served to a
session, first handed over more than a day ago, it counts how many a later episode went on to
mention or cite. That says whether served memory was used, where the first rate says only
whether it came back.

```
aion stats                    # the "recall self-probe" section carries both rates
```

A probe must teach the substrate nothing, or the next run scores what the last one taught it.
Its recall runs with no listener (no reinforcement rows, no access stamps, no usage events),
with session dedup off, under a session identity of its own, and against a throwaway in-memory
store. The pack it persists, the served rows it would record, and the cadence and pack-method
counters it moves all land in that store and go when the run ends. One thing it does count: the
cue call, in `generation by route`, because a probe call is a real call on a real route.

Both rates read as unmeasured rather than as zero until there is something to measure. Served
rows go when their session closes, so on an install whose sessions are short the served rate
reports that no item was old enough to judge. That is a fact about the sessions on file, not
about how memory is being used.

`AION_MAINTENANCE_RECALL_PROBE` (default `true`) is the kill switch: off, nothing is asked and
both rates stand where the last run left them. `AION_RECALL_PROBE_SAMPLE` (default `3`) is how
many experiences one run asks back for. Each one is a full recall, cue call included.

`aion maintain run recall_probe` declines with a noop. The probe's recall is assembled by the
running service, and a CLI run holds none, the same as `curiosity` and its intake path.

## Removing an install

`aion uninstall` is init's mirror. It works out what to do before it does any of it, prints the
plan in three groups, and asks twice.

- **remove** is what this install put there and can prove it: the launchd job, the config lines
  still carrying the values init wrote, a plugin jar init downloaded, and the data root. On the
  docker profile it is `compose down --volumes` instead.
- **manual** fires only when there is no install record at all (a native install from before
  the manifest, or one assembled by hand). It prints one instruction: check the plugins
  directory and `neo4j.conf` by hand before removing anything there. When a manifest exists,
  anything this install did not set up (a Neo4j already running, a plugin jar somebody placed)
  is left out of the plan rather than listed here.
- **keep** is the shared tools. Homebrew's Neo4j, Ollama and the models are never removed as a
  side effect; the commands to remove them yourself are printed in a block at the end.

The install manifest is what makes the **remove** group possible. An install with no manifest
still has everything uninstall can name for itself removed, and the rest listed as present and
not provably ours.

The second question is the data root, and `--yes` does not answer it: the path has to be typed
back. That directory is the memory store, and `--yes` exists so a script can re-run an install
rather than so it can delete one. It is idempotent over a half-installed machine: what is not
there is not in the plan, and a job that was never loaded does not stop the step after it.

## Resetting the substrate

A reset deletes everything the substrate holds, so it is a documented procedure rather than a
command.

**Both stores go, or neither.** A substrate is the graph and the database together, and the half
that survives cannot be adopted by a new one: with the database dropped and the graph kept, the
service throws `publication_foreign_graph_pairing` at its next start, and the other way round it
throws `publication_guard_missing_or_ambiguous`. `aion init` and `aion doctor` both check the pair
(check `store-pairing`) and refuse a half reset with the two drops printed, rather than leaving it
to surface as a boot failure.

On the docker profile:

1. Stop the service: `docker compose --profile mcp down`.
2. Optional, if you want a way back: take a cold copy of the two volumes while nothing is
   running.
3. Drop them: `docker volume rm aion_aion-neo4j aion_aion-data`. This deletes the graph, the
   SQLite database, and the experience archive. Nothing survives it.
4. `aion init full` (or `local`).

On the native profile the same two drops are two directories:

1. Stop the server: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.aion.mcp.plist`.
2. Stop Neo4j: `brew services stop neo4j`, or however it runs.
3. Drop the substrate's own directory: `rm -rf ~/.aion` (`$AION_DATA_DIR` if you moved it). That
   is the SQLite database, the experience archive and the log.
4. Drop the graph. Community Edition cannot replace its default database from Cypher, so it is a
   file drop: with the server stopped, remove the `databases/neo4j` and `transactions/neo4j`
   directories under Neo4j's data directory. `SHOW SETTINGS 'server.directories.data'` on a
   running server names it, and on a Homebrew install it is `$(brew --prefix)/var/neo4j`.
5. Start Neo4j again, then `./bin/aion-native init --install native`.

The next init is then the fresh-substrate case, so the first thing the new substrate remembers
is being initialized.

## Coverage state

`aion init` opens the coverage contract in the `preparing` state and the first service start
activates it. A preparing contract promises no history: every read that names `as_of` or
`knew_at` comes back partial with the limitation `coverage_contract_not_active`, and no read
carries a history horizon. There is no manual step.

Two surfaces report it, both read-only:

- `aion doctor`, check `coverage-state`. It warns while the contract is preparing and fails when
  the record cannot be served at all.
- `GET /health`, keys `coverage_state` (`preparing`, `active` or `failed`),
  `coverage_history_since` and `coverage_epoch`.

Activation writes the horizon at the moment it happens and never earlier. A substrate that ran
for a while before activating gets a horizon at the activation, so reads into the time before it
are refused as `before_horizon` rather than answered from history nobody promised.

`GET /health` also carries the queue and plasticity counters `aion status` reads: `queue_depth`,
`queue_oldest_unclaimed_ms`, `queue_exhausted`, `queue_index_depth`, `reinforcement_dropped`,
`enrichment_lag_p95_ms`, `cue_degraded_rate`, `supersession_proposals_open` and
`entity_merge_proposals_open`, then `reinforcement_signals_applied`,
`reinforcement_pairs_applied`, `reinforcement_edges_updated`, `reinforcement_last_run_at`,
`reinforcement_queue_depth`, `decay_edges_scanned`, `decay_edges_decayed` and
`decay_last_run_at`. The rest is base liveness: `status`, `sessions`, `descriptions_version` and
`build_sha`.

## Logs

`aion logs` tails it: `-n` lines (50 by default), `--level` filters by floor, `-f` follows, and the
first line is the file it read. Following survives a rotation: the size going backwards means the
file was replaced under it, and the tail reopens from the start of the new one.

Everything writes structured JSONL to one file, `/data/logs/aion.jsonl` on the data volume by
default and `~/.aion/logs/aion.jsonl` on the native profile. The service tees the same records to
stdout, which `docker logs aion-aion-mcp-1` reads on the docker profile. The launchd job sends
that copy to `/dev/null`, since nothing rotates a launchd file and the JSONL is the durable copy.
A native install's pre-logger crash output lands in `aion-mcp.launchd.err.log` beside the JSONL.

A CLI run does not tee: stdout is where a command writes its answer, so a log record there would
break the single JSON object `--json` promises. The service logs under the name `aion-mcp`, and
every CLI run under its command's name. `AION_LOG_LEVEL` moves the level (`debug` through
`fatal`); writes are synchronous, so a crash keeps the tail that explains it.

The container's stdout copy is capped by the compose `logging` block (10 MB × 3); the file on
the volume is the uncapped durable record. The file ages out on its own.
`AION_LOG_RETENTION_DAYS` (default `1`, fractions accepted) is the window: a file whose last
write is older than it becomes `aion.jsonl.1` when the next process opens a logger, and a rolled
copy with nothing to replace it and an age past the window is deleted. So the disk holds the
current window and the one before it.

Enforcement runs wherever a logger opens, which is every CLI command and every service start, so
both profiles get it without a second place to wire it. The first start after an upgrade ages out
whatever the old build left and writes one line saying so. This is the file logger only. The
graph's transaction logs are Neo4j's own `db.tx_log.rotation.retention_policy`.

The harness hooks are the one component outside the containers; each fire appends one line to
`~/.aion/hook-state/hooks.log` on the host.

## Configuration

Every runtime knob is an `AION_*` environment variable, declared with its type and default in
`packages/core/src/infrastructure/config/knobs.ts`. That file folds in the `maintenance`,
`reflection` and `temporal` groups' own tables from the files beside it.

`.env` is for what an install has to decide: endpoints, models, the key, the behavior switches.
Values copied into `.env` stop following the code that calibrated them, so leave a tuning knob
alone unless a measurement says otherwise. An unknown `AION_*` variable fails the boot loudly;
a knob that once existed and was retired is ignored with no complaint.

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
two-pass judge unanimously calls the pair one assertion restated. The older claim survives, the
newer one's source episode folds onto it, and the newer closes with the same `SUPERSEDES`
lineage a contradiction close writes, so `aion unsupersede` reverses it like any other close.
`AION_MAINTENANCE_CLAIM_DEDUP` (default `true`) is its kill switch. `AION_MAINTENANCE_CLAIM_DEDUP_BATCH`
(default `5`) bounds pairs judged per run, since every pair costs up to two model calls.
`AION_MAINTENANCE_CLAIM_DEDUP_COSINE_FLOOR` (default `0.73`) is the nearest-neighbor floor a
pair must clear before the judge is asked at all. A pair is judged once, ever: the verdict is
ledgered under a permanent key on the unordered pair, so a re-run never pays for it twice.

The narrative chunk lifecycle and the eviction that follows it carry five knobs of their own, all
unmeasured defaults rather than calibrated ones. `AION_MAINTENANCE_CHUNK_MAX_SPAN_MS` (default
`86400000`) is how long a session's unsealed tail may stand before the span trigger seals it.
`AION_MAINTENANCE_CHUNK_RENDERED_INPUT_ALLOWANCE` (default `16384`) is the rendered-input budget a
chunk is sealed and published under. `AION_MAINTENANCE_NARRATIVE_SEAL_BATCH` (default `2`) bounds
publication attempts per invocation, where one attempt is one chunk revision rather than one source
or one model call. `AION_MAINTENANCE_EPISODE_EVICT_MIN_AGE_MS` (default `86400000`) is how long a
source's complete coverage must stand before its raw projection may go, measured from recorded
clocks and never from `occurred_at`. `AION_MAINTENANCE_EPISODE_EVICT_BATCH` (default `8`) bounds
eviction attempts per invocation, one source each.

`AION_RECALL_PATH_STRENGTH_SLOTS` (default `2`) bounds the disclosed path-strength lane: how many
activation-only arrivals with no qualifying cosine and no exact match may still reach a pack, per
pack, admitted on their own accumulated activation score rather than on any content floor. The
floor policy itself is untouched by this knob; the lane is a separate, bounded door, marked
`path_strength` in `admitted_by` so a reader can see which door an item came through. Set it to
`0` to turn the lane off and get a pack byte-identical to one built before it existed.

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
