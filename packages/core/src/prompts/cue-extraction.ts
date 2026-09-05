/** The recall hot path's one call: search cues per section, plus the query's intent. */

/**
 * Two things this prompt has to hold, both measured against the pinned cue model.
 *
 * Invention: a query naming a topic the substrate has never held still produced confident,
 * on-topic-looking cues, so the ban on leaving the section is stated as a rule and repeated
 * as an instruction to return nothing rather than guess.
 *
 * Intent: whether a query asks what was chosen is a judgment, and the alternative to asking
 * for it is a keyword list, which the cognitive path does not get. Every clause after
 * "query_intent" is here because the model got that case wrong without it: a recommendation
 * read as a decision, a bug report read as a decision, and "why did we reject X" read as a
 * cause rather than as the choice it names. With them, the judgment was right on 11 of 12
 * probe queries and identical across three runs; without them, on 8 of 12. The survivor is
 * "what was that bug in the barrel exports", read as a decision; an over-fired boost lifts
 * Decision and Insight and admits nothing, so it costs ranking rather than honesty.
 */
const CUES =
  'You extract short semantic search cues from an AI agent memory-recall query. ' +
  'A cue is a concept, entity, or theme worth searching a memory graph for, not ' +
  'necessarily an exact word from the input. The user message has three sections: ' +
  'the query, the conversation summary, and the recent turns. Extract cues separately ' +
  'for each section. Return an empty array for a section marked "(none provided)". ' +
  'Every cue must be about something the section itself names. Never introduce a topic, ' +
  'domain, or entity the section does not mention, and never guess what the user might ' +
  'have meant: if a section names nothing worth searching for, return an empty array for ' +
  'it. Fewer, well-grounded cues are better than more. Keep each cue to a few words and ' +
  'do not repeat one within its own section. ' +
  'Then judge the query. ' +
  'query_intent is "decision" only when the query asks which choice was already made or why ' +
  'it was made, as in "what did we decide about X", "did we decide to X", "why did we reject ' +
  'X". Everything else is "other", including a question asking for a fact, a number, a ' +
  'measurement, a bug, or a recommendation. "what is the best anchovy brand for puttanesca" ' +
  'is "other", because it asks for a recommendation rather than a choice already made. ' +
  '"what was that bug in the barrel exports" is "other", because it asks what happened ' +
  'rather than what was ' +
  'chosen. "why did we reject the Kafka proposal" is "decision", because a rejection is a ' +
  'choice that was already made, even though the question opens with "why". ' +
  'Judge the query alone: the summary never changes this answer.';

export const LOCAL = CUES;
export const KEYED = CUES;
