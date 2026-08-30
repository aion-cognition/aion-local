# Manual exercise round — 2026-08-30 (overnight)

Hands-on round against the live substrate, fresh after the reset (init at 31cb054, empty graph, Anthropic key present). No scripts: real MCP tool calls over streamable HTTP, realistic content from the night's actual work, every pack judged by hand. Seven reflections across two sessions (one deliberate contradiction pair, one scratch item for forget), recall probes from a third session, and the CLI surfaces as a user.

## What passed

- **Cross-session recall with rendered whys.** Decisions reflected in session A came back in session C with their rationale lines rendered ("Typing each boundary once is more efficient than annotating hundreds of sites"). Day-zero pack quality is high.
- **Cue extraction earns its latency.** The zero-overlap probe "agents that keep running while nobody watches" expanded to "autonomous agents / running unattended / background agents" and retrieved exactly the right memories. Inference-first extraction doing real semantic work.
- **Resonance contributes from day zero.** Items with no lexical overlap surfaced in a separate resonant bucket on a 130-node graph.
- **Floors are selective.** 57 considered / 9 admitted on-topic; 62 / 1 on an absent topic. No confabulated admissions.
- **Routing reads clean off one screen.** `aion status` shows the Haiku routing, a plain-English disclosure of exactly what leaves the machine, and reconciliation had already evicted the local generation models (`ollama ps`: nomic only). Enrichment p95 30-56s on Haiku against the hours-slow local history.
- **Bitemporal integrity on the wire.** `as_of` before the correction returns the old belief, rank 1, exactly as known then. `forget` previews, requires `--yes` without a terminal, closes instead of deleting, and says so: "nothing was deleted; --as-of/--knew-at reads still find it."
- **Supersession machinery works where it looks.** The reaping-cause gloss (Claude Code update vs cmux) got superseded correctly during enrichment.
- **Direct-question arbitration.** Asked "is it safe to rely on background shell tasks overnight," the correcting insight ranks 1 and the stale belief trails at rank 5 below its correction.

## Findings

1. **Turn-vs-insight contradiction blindness.** The planted stale belief lives only as a raw Turn node (`reflection_intake`); the b2 extraction never distilled it into a claim, and supersession candidates are extracted cognitive nodes, so the pair was never judged. Consequence: the stale turn stays current forever, and when resonance surfaces it without the correction co-retrieved (it did), the pack carries a contradicted statement with no contradiction context. Direct questions arbitrate fine; lone surfacing does not. Needs a design call: pack-level contradiction annotation against the subject family, or excluding raw turns from resonant surfacing when a contradicting current insight exists.
2. **Floor honesty question.** The absent-topic probe admitted one item displaying confidence 0.53 under `corroboration_floor 0.55`. Either the rendered confidence is not the score the floor judged (display-vs-decision mismatch) or the admission path has a hole. Which is it?
3. **The per-method spirit metric is missing from `aion stats`.** The P5 pin says per-method pack contribution ships permanently in stats; the section is not there (substrate / queue / plasticity / cadence only), while `aion last` clearly has per-item method data to aggregate.
4. **CLI swallows unknown flags.** `aion stats --help` and `aion stats --recall` both silently run plain `stats`. Usage errors should be visible (same class as the round-2 stream-hygiene finding).
5. **Introspector has not scheduled plasticity ops on a live substrate.** Reinforcement queue depth 1,099 with 0 flushed, decay never run, across the whole round. If tier-2 thresholds only fire at scale, a fresh personal graph may never reach them; cadence wants a floor (or the thresholds want re-reading).
6. **Wire shape drops empty sections.** An absent-topic response omits `episodes`/`resonant` keys entirely instead of sending empty arrays. Typed consumers see an inconsistent shape; the CLI is such a consumer.
7. **`aion last` renders an `as_of` pack without marking it time-traveled.** Minor, but a reviewer reading "what did the substrate last serve" can be looking at a deliberately historical view with no indicator.
8. **From the merge leg, already relayed: the test harness degrades enrichment routing silently** when the Anthropic key is absent (a gate run cannot tell which model built its substrate), and the measured Haiku-vs-8B delta on the held-out battery is green vs 21/24.

## Reading

The cognitive spine — reflect, enrich, recall, resonate, time-travel, forget — held up under real content with no scripted assistance, on interactive latency, with honest floors. The findings cluster at the seams (contradiction coverage for raw turns, observability gaps, wire-shape consistency), not in the loops. That matches where the build's attention has and hasn't been, which is what an exercise round is for.
