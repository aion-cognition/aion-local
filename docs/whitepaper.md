# Aion: what this is and why

Adapted from the Aion whitepaper, "Aion: Active Cognitive Substrate," by Ryan Huber. This is
the short version, for someone who just cloned the repo and wants to know what the system is
and why it is built this way. The full paper carries the algorithms and the parameter tables.
Pointers to the rest of these docs are at the bottom.

## Memory is a process

Most agent memory is retrieval. Log the conversation, embed the text, answer a query by
nearest-neighbor search. That works for question-answering over static documents. It fails for
an agent that runs over months, and it fails in three specific ways.

**Retrieval is not recall.** A search engine returns documents ranked by similarity. Recall is
constructive: it assembles context from different memory structures, weighted by recency,
strength, and associative activation. Search finds what matches; recall constructs what
matters.

**Storage is not memory.** A vector database stores embeddings. A memory system maintains
structure: weighted relationships that strengthen with use and fade with neglect, narrative
compressions, and nodes for goals, decisions, and insights. Storage is necessary for memory. It
is not memory.

**Conversation is not experience.** In most agent stacks, tool execution results are consumed
in one turn and thrown away. An agent that searches the web does not learn from the search. A
memory that sees only conversational text misses half of what the agent did, which is why the
`reflection` tool takes `tool_executions` and `observations` alongside `turns`.

## What remembering requires

The requirements come from ordinary remembering, taken seriously as a specification.

Prior knowledge does not become irrelevant when things change. It turns into lessons that
inform how thinking happens next. So no pathway is ever deleted: weights fade to a floor and
stop there, and that accumulated structure is what past experience contributes to recall.

Nobody remembers a book word for word. What stays is the gist, and the sense of where to look
when the detail matters. That is the narrative layer: compressed summaries stand in for their
episodes, with provenance links back to the full record.

Knowing which information is useful, and when, is itself learned. Similarity can be computed
fresh on every query. Relevance has to be earned across many of them, which is what
reinforcement and decay do. Two systems with the same history and different usage end up with
different graphs.

Then there is the recall that arrives on its own. The actor's name shows up after you quit
trying to remember it. That kind of recall is associative, keyed to the situation rather than
the question. Context resonance is a mechanism for it. Partial is the honest word.

And most of memory's work happens while attention is elsewhere: consolidation, reorganization,
repair. Reflection and introspection are that half of the system, the part that runs when
nothing is being asked. A memory with only a read path has no such half, and after enough time
that absence shows.

## Correction without deletion

A fact that turns out to be wrong is still something the substrate believed, and that record is
how an agent explains why it once reasoned the way it did. So correcting a fact supersedes it:
the old node's intervals close and `(new)-[:SUPERSEDES]->(old)` is written in the same
transaction. Nothing is hard-deleted here, and a repo-wide test fails the build on any Cypher
delete.

That is also why every node carries two time intervals rather than one. World time
(`valid_from` / `valid_until`) is when the fact was true. System time (`tx_from` / `tx_until`)
is when the substrate held the belief. `as_of` asks what was true last month, `knew_at` asks
what this system thought last month. One interval cannot answer both, and the gap between the
two answers is where a correction lives.

Default recall does not filter superseded knowledge out. It labels it. Every returned item
carries `current` or `superseded`, and a superseded item carries a pointer to what replaced it
and when. Filtering it would make the substrate look like it had always been right. `aion
forget` is the one suppression and still not a deletion: it sets `forgotten_at`, default recall
stops serving the node, and a time-travel read still returns it.

An empty pack is an honest answer. Nothing relevant is stored, and that is not a failure. The
admission floors exist so a pack can come back empty rather than padded with weak matches the
agent then reasons from.

## The three loops

Three loops run over one graph, and their separation is a correctness requirement.

**Recall constructs.** It is synchronous and sits inside the agent's reasoning cycle: cue
extraction, seed selection, spreading activation, fusion, resonance, pack assembly, all inside
a time and token budget. As a side effect it nominates the pairs that co-activated, off the
latency path. Remembering strengthens the pathways that made remembering possible.

**Reflection distills.** It is asynchronous and runs after an episode is durably stored, from a
queue row. It extracts entities, deduplicates them against the graph, infers associations,
extracts the nine cognitive node types (goals, plans, decisions, insights, concepts, contexts,
events, patterns, trends), builds typed relationships, judges contradictions, and compresses a
session into a narrative. Every stage fails independently, and an operations ledger gates
re-entry, so no episode is learned twice through any number of retries or crashes.

**Introspection repairs.** It is continuous, runs on the service's own clock through observe,
decide, act, learn, and is the only loop no caller triggers.

Each separation buys something. If recall waited on reflection, every recently stored episode
would degrade recall until the pipeline caught up. Under recall's latency budget, reflection
would skip deduplication and simplify extraction. Triggered by usage, introspection would never
maintain a quiet system and would repair a busy one at the worst possible moment.

They interact through the substrate, not through calls: reflection enriches what recall reads
and recomputes the context vectors resonance queries, and introspection repairs what both
depend on while folding the pairs recall nominated into edge weights.

## Context resonance

Every node carries two embeddings. The content vector encodes what the node is about, a direct
embedding of its text. The context vector encodes what it connects to, a strength-weighted mean
of its neighbors' content vectors, recomputed when the neighborhood changes.

Resonance is a second retrieval pass over that second index. After the first pass anchors, the
activation-weighted mean of the activated set's context vectors becomes a query against the
context index, excluding everything the first pass already produced. What comes back lives in a
similar relational neighborhood while its words may share nothing with the query.

The mechanism models a familiar experience. You think about a project deadline, and a memory of
a different project surfaces, one with similar team structure and similar pressure. The content
differs. The context is similar.

Resonant items land in their own pack bucket and never compete with a fused score, so a pack
keeps what matched the question separate from what resonated with the situation. The stage
declines to run on a query nothing anchored, since resonating from an unanchored pack searches
the shape of nothing.

## Hebbian plasticity

A fixed-weight graph cannot express that some relationships matter more, or that relevance
changes. Edges between co-activated nodes strengthen; unused edges decay. The name borrows
Hebb's principle as a structural metaphor and claims no biological fidelity. Reinforcement is
bounded, so an edge gains less the stronger it already is and no weight passes 1.

Decay is a bell curve against staleness, not a monotonic slide. It peaks at a configurable
window of disuse and falls off on both sides: an edge touched yesterday decays slowly because
it may still matter, and one idle for a year decays slowly because it has already settled near
the floor. An edge idle for exactly the peak window decays fastest, which is where trimming it
buys the most signal-to-noise. The floor is the most important parameter. No edge reaches zero,
so a faded pathway still carries activation if the cue is strong enough. Faded, not gone.

Reinforcement is generated on the recall path and executed by introspection in batches, so
plasticity is eventually consistent and recall latency is untouched.

## The introspective maintenance loop

Memory graphs develop pathologies on their own schedule: nodes lose embeddings, entities
fragment under different names, narratives go stale, clusters form with no path between them.
At dozens of nodes these are visible by inspection. At thousands they are invisible until
recall degrades, and human curation stops being a strategy.

One tick runs four phases. **Observe** assembles one health snapshot of graph structure, queue
lag, enrichment coverage, plasticity, proposals and redaction residue, every collector caught
on its own. **Act** then runs at most one operation, under bounded scope, a protected
relationship set, and a ledger claim on its time window so nothing runs twice.

**Decide**, in between, is pure: the same snapshot always produces the same answer, so a
decision is arguable from the numbers. An operation that names a critical condition the
snapshot meets preempts the whole catalog, and that preemption expires once it stops moving the
metric it declared, because a condition can stand for weeks and nothing else may wait that
long. Otherwise operations score on their own relevance, weighted down when their runs stop
improving anything and up the longer they wait, so nothing starves. The model-guided tier is
the last fallback, opt-in and propose-only here.

**Learn** is what makes the loop a loop. Every operation declares the one metric it exists to
move. The engine reads it before the run and again on a later tick, when the system has
settled, and records improved, unchanged, or failed. Those counts are the weight the next
decision reads.

## The MemoryPack is the contract

Recall returns a MemoryPack, and that is the whole interface between memory and reasoning. Five
buckets, each present only when it has content: `facts`, `episodes`, `narratives`,
`preferences`, `resonant`. Every item carries its content, its rank, the confidence behind its
admission, a rationale naming which method found it and through which path, and a currency
marker. The pack also carries a rendered text block, the extracted cues, and stage timings.

The pack is a self-contained context supplement, not a ranked result list. Ranking and
admission are separate: an item reaches the pack only on absolute evidence, however well it
ranks against its neighbors. And a pack says what it is short of. A degraded cue model, a
spread that stopped on its budget, episodes stored but not yet enriched: all of it lands in one
plain line at the top of the text block, so a client reading only the text sees the same
honesty as one reading the metadata. `preferences` has no producer yet, so it is structurally
absent rather than empty.

## Cue extraction is inference-first

Recall's first stage turns the query, and optionally a summary and recent turns, into weighted
cues. It is one model call, with no keyword extractor, no stopword list, and no regex behind
it.

That is a rule. Degradation here means doing less inference, never switching to heuristics. A
keyword fallback looks like resilience and is not: it silently answers a different question
from the one the pipeline was built around, at the moment the caller can least tell. So the
fallback is a single raw-query cue, and the pack records that it degraded.

Redaction is the one place inference is deliberately not used: credential detection is
deterministic and rule-based, because a leak cannot wait on a model's judgment.

## Engrams: designed, not built

The design models memory as nodes and weighted edges, and recall returns activated nodes. The
activation patterns themselves are transient, computed per query and then discarded. A
situation the agent has met many times strengthens the edges among its parts, but the pattern
as a whole is never an object, so the system cannot match a current situation against a stored
pattern, complete a partial one, or abstract across similar patterns into schemas.

An engram would be a persistent representation of a recurring activation pattern: its
constituents and their weights, a signature vector, a consolidation state. Spreading activation
becomes a detection mechanism that can persist what it finds. This is designed and not built.
No engram code exists in this repo. It is named here because it is the ceiling of the current
design, and naming a ceiling beats implying there is none.

## How this repo maps to the paper

Aion Local is the paper's architecture adapted to one person on one machine. The three loops,
the five node families, dual content and context vectors, spreading activation, RRF fusion,
context resonance, bounded reinforcement and bell-curve decay with a floor, the tiered
maintenance loop, idempotent consolidation through an operations ledger, and the MemoryPack
contract all carry over.

The surface is two MCP tools, `recall` and `reflection`. Neo4j holds the graph and its vector
indexes. SQLite holds the reflection queue, the operations ledger, the proposal queues, and the
last-pack cache. Generation runs on Ollama on the host. Set an Anthropic key and the two
generation roles, cue extraction and reflection, route to Haiku instead of the local instruct
model. Embeddings stay local either way, because the vector space is the substrate.

Where this build differs from the paper:

- **No tenancy and no authorization.** The paper's tenant boundary and its access control exist
  to separate people, and one user on one machine has nobody to be separated from. The backbone
  is a Member node and a Workspace node, with no Tenant.
- **One process, not three services.** The paper deploys a memory engine, a reflection worker,
  and an introspector over Postgres and Redis. Here one MCP server runs all three loops, and
  SQLite carries the queue and the ledger.
- **Redaction is credentials only.** The paper puts PII detection at ingestion. This detects
  keys, tokens, and connection strings, and does not detect patient data or other regulated
  content. A deployment where such data can reach the substrate needs something this lacks.
- **No keyword fallback.** The paper falls back to keyword extraction when the cue model fails.
  This falls back to the raw query, per the rule above.
- **Bitemporal stamps, supersession, and forget are an extension** the paper does not describe.
  They are the section above.
- **Some tuned values disagree with the paper's appendix** (the episode cap, the summary cue
  weight, the cue-call budget), each on a measurement `architecture.md` records.
- **Fourteen maintenance operations are registered**, and four the paper names are not, each
  for a reason `architecture.md` gives. Entity unmerge sits outside the catalog on
  purpose, since a bad merge and a correct one have the same shape in the graph.
- **One implementation.** The paper describes two, TypeScript and Go. This is the TypeScript
  one.

For the pipelines, bounded contexts, and graph schema, see
[architecture.md](architecture.md). For failure modes,
[degradation.md](degradation.md). For the hooks that put recall and reflection on a
cadence, [harness.md](harness.md). For setup, the README.
