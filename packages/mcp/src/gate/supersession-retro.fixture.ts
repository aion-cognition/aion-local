/**
 * RETRO. The supersession proposals a person actually ruled on, transcribed from the live
 * substrate on 2026-08-30, with the ruling each one got.
 *
 * These are hindsight numbers and they are kept apart from the pre-registered battery on
 * purpose. The battery's ground truth was committed before any model answered; these rows were
 * decided after the fact, by one person, over one afternoon, on claims the substrate produced
 * about its own construction. A model judge is not deterministic either, so what an agreement
 * rate here says is "the two-pass judge would have ruled the same way", not "the two-pass judge
 * is right this often". Mixing the two figures would launder the second into the first.
 *
 * The rulings are read off the graph in three classes, not two, and the third is why: a
 * resolved row proves someone decided, and nothing more. Where the `SUPERSEDES` edge into the
 * older claim was written by this row's newer claim, the person applied it. Where the older
 * claim still holds currency, they dismissed it. Where the older claim has lost currency to
 * something other than this row's newer claim, nobody chose either way: a neighbouring apply
 * had already taken it, and the row was cleared because there was nothing left to do. Reading
 * that third class as a dismissal invents a refusal nobody made, and scores the judge against
 * it: two of these eight rows are that shape, and both were the same older claim taken by one
 * family close.
 *
 * Eight rows exist. Five carry a ruling and are scored. Two are stale clears and one was open
 * when this was transcribed; all three are kept here so the set is the whole queue rather than
 * the convenient part of it.
 *
 * RETRO measurement, 2026-08-30, claude-haiku-4-5, two-pass judge: agreement 3/5 (0.600), plus
 * three rows judged and unscored. Both disagreements run the safe way, on rows a person applied
 * and the second pass would have held for review; on the two false positives the first pass
 * produced live, and on the garbled-extraction row, the two-pass judge holds where the person
 * held. Read against the battery's 1.000 this is the honest gap: a designed pair is cleaner
 * than a claim the substrate wrote about its own construction, and five rows decided by one
 * person in one afternoon is a sample, not a rate.
 */

/**
 * What the graph says happened. `stale` and `open` are both unscored, for different reasons:
 * a stale row is one nobody decided, and an open row is one nobody has decided yet.
 */
export type RetroRuling = 'applied' | 'dismissed' | 'stale' | 'open';

export type RetroRow = {
  readonly key: string;
  readonly ruling: RetroRuling;
  /** For a stale row, what the graph showed that made it one. */
  readonly staleNote?: string;
  readonly subject: string;
  readonly priorLabel: string;
  readonly prior: string;
  readonly currentLabel: string;
  readonly current: string;
  /** The confidence the single-pass judge attached, kept to show what it was worth. */
  readonly confidence: number;
};

export const RETRO_ROWS: readonly RetroRow[] = [
  {
    key: 'mcp-cross-session',
    ruling: 'applied',
    subject: 'MCP tools',
    priorLabel: 'Insight',
    prior:
      "MCP tools (recall/reflection) require a new session because servers connect at startup and are not available in the current session's toolset.",
    currentLabel: 'Insight',
    current:
      'A new session successfully picks up the MCP installed in an earlier session, resolving the open question about cross-session persistence.',
    confidence: 0.85,
  },
  {
    key: 'env-seeding-vs-archive',
    ruling: 'dismissed',
    subject: '.env',
    priorLabel: 'Decision',
    prior:
      "Made the seed its own function so every init-time writer runs it first, ensuring a fresh install's `.env` carries the whole documented surface.",
    currentLabel: 'Decision',
    current:
      'Use `git archive` to package only tracked files, excluding `.env`, `node_modules`, `.git`, and other ignored content.',
    confidence: 0.85,
  },
  /**
   * The distortion this set exists to avoid. The older claim here is the same one the first row
   * closed, and the row was cleared afterwards with nothing left to take. Read two ways it is a
   * dismissal, and the two-pass judge closing it reads as an unsafe-direction disagreement;
   * read from the graph it is a decision nobody made.
   */
  {
    key: 'recall-tools-available',
    ruling: 'stale',
    staleNote:
      'the older claim lost currency to a different newer claim, under supersession_proposal_applied',
    subject: 'recall tools',
    priorLabel: 'Insight',
    prior:
      "MCP tools (recall/reflection) require a new session because servers connect at startup and are not available in the current session's toolset.",
    currentLabel: 'Insight',
    current:
      'The substrate built overnight has introduced itself mid-conversation, demonstrating that the recall and reflection loop is now closed.',
    confidence: 0.85,
  },
  {
    key: 'new-session-vs-hook-fired',
    ruling: 'stale',
    staleNote:
      'the older claim lost currency to the same family close, under supersession_subject_propagation',
    subject: 'MCP and hooks',
    priorLabel: 'Event',
    prior:
      'User asks whether a new session is needed to pick up the MCP and hooks after keeping current settings as-is.',
    currentLabel: 'Event',
    current:
      'The UserPromptSubmit hook fired in the current session and briefed the assistant from the graph, including work from a later session that was never directly observed, such as the install, claudebar hook merge, minime retirement, and connectivity verification at 16:54.',
    confidence: 0.85,
  },
  {
    key: 'merge-routing-blocked',
    ruling: 'applied',
    subject: 'entity merge execution',
    priorLabel: 'Event',
    prior:
      'One supersession proposal was applied, three were dismissed, and entity merge execution was blocked pending core implementation of merge-apply routing.',
    currentLabel: 'Event',
    current:
      'code-92 discovered that `aion proposals apply` never routed entity-merge proposals and is wiring it now; its live batch showed 8 exact-name pairs at similarity 1.000 were correct, false pairings scored under 0.91, and the supersession judge went 1-for-4 (0.400 precision).',
    confidence: 0.85,
  },
  {
    key: 'merge-threshold-vs-judge-precision',
    ruling: 'dismissed',
    subject: 'automated merging and judging reliability',
    priorLabel: 'Insight',
    prior:
      'Entity merges at similarity 1.000 with identical normalized names across different types show 100% accuracy, while false pairings score below 0.91, suggesting a reliable threshold for safe automation.',
    currentLabel: 'Event',
    current:
      'Haiku re-measure completed with precision 0.857 (12 TP, 2 FP, 0 FN, 10 TN), recall 1.000, but all affirmative judgments emitted exactly 0.95 confidence with no signal differentiation.',
    confidence: 0.82,
  },
  /**
   * The live firing that motivated the well-formedness check. The favoured side is a mangled
   * imperative built out of two unrelated pairs, and the single-pass judge preferred it to a
   * coherent claim at 0.92, its highest confidence in the whole queue.
   */
  {
    key: 'garbled-imperative',
    ruling: 'dismissed',
    subject: 'the supersession judge',
    priorLabel: 'Insight',
    prior:
      "The supersession judge's pattern-matching errors (conflating unrelated .env contexts, pairing non-contradictory claims) reveal systematic weaknesses that require judge improvement rather than automation of current logic.",
    currentLabel: 'Decision',
    current:
      'Pair non-contradictory claims in supersession decisions where judges measure different aspects: init-time .env seeding vs git-archive exclusion, and merge-threshold reliability vs supersession-judge precision.',
    confidence: 0.92,
  },
  {
    key: 'merge-auto-arming',
    ruling: 'open',
    subject: 'entity merge auto-apply',
    priorLabel: 'Decision',
    prior:
      'Entity merges should auto-apply for exact-name cross-type pairs with everything else queued-but-not-blocking, shipping in observing-only mode first and arming after weeks of shadow agreement.',
    currentLabel: 'Decision',
    current:
      'Enable `merge_auto` to apply exact-name pairs automatically with `auto_merge` provenance, keeping only a kill switch for incident response.',
    confidence: 0.72,
  },
];

/** An applied row is a closure the person let stand; a dismissed one is a closure they refused. */
export function agreesWithRuling(ruling: RetroRuling, closed: boolean): boolean {
  return ruling === 'applied' ? closed : !closed;
}

/** The rows an agreement rate may be computed over: someone chose, and the choice is readable. */
export function ruledRows(): readonly RetroRow[] {
  return RETRO_ROWS.filter((row) => row.ruling === 'applied' || row.ruling === 'dismissed');
}

/** Judged and reported, never scored: nobody decided these, so there is nothing to agree with. */
export function unscoredRows(): readonly RetroRow[] {
  return RETRO_ROWS.filter((row) => row.ruling === 'stale' || row.ruling === 'open');
}
