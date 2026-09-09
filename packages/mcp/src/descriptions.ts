/**
 * The descriptions are tuned artifacts, not documentation. A tool-based memory
 * only works if the agent calls it, so each description states when to invoke as much as
 * what the tool does, and the version travels with every tool definition (`_meta`) so
 * observed cadence can be attributed to the text that produced it.
 *
 * Bump `DESCRIPTIONS_VERSION` on every edit to any string in this file.
 */
export const DESCRIPTIONS_VERSION = 4;

/** The `_meta` key the version is published under, so a cadence report can group by it. */
export const DESCRIPTIONS_VERSION_META_KEY = 'aion/descriptions_version';

export const RECALL_TOOL_NAME = 'recall';
export const REFLECTION_TOOL_NAME = 'reflection';
export const SOURCE_SEARCH_TOOL_NAME = 'source_search';
export const SOURCE_TOOL_NAME = 'source';

export const RECALL_TITLE = 'Recall memory';
export const REFLECTION_TITLE = 'Store experience';
export const SOURCE_SEARCH_TITLE = 'Search captured sources';
export const SOURCE_TITLE = 'Read a captured source';

export const RECALL_DESCRIPTION = [
  'Search persistent memory of earlier sessions and return what bears on the work at hand:',
  'past episodes, the decisions inside them, and why they were made. The result carries both',
  'structured items and a rendered text block that can be read directly.',
  '',
  'Call recall:',
  '- at the start of a session, with a query describing the work being picked up, to ground yourself in what came before;',
  '- before starting work on a topic, so an earlier decision and its reasons arrive before you re-derive them;',
  '- when the conversation turns to a new topic;',
  '- before assuming anything about this user, this codebase, or a decision someone already made.',
  '',
  'Recall is cheap and safe to call more than once in a session. An empty pack is a real answer:',
  'nothing relevant is stored, which is not a failure. Pass the conversation context (summary and',
  'recent turns) when you have it... it sharpens what comes back. Use `as_of` to ask what was true',
  'at a past date, `knew_at` to ask what memory held at a past date.',
].join('\n');

export const REFLECTION_DESCRIPTION = [
  'Store what just happened in persistent memory so a later session can recall it. Send raw',
  '`turns`, the `tool_executions` behind them, and/or `observations`... distilled notes stating a',
  'conclusion, a decision and its reason, or something learned.',
  '',
  'Call reflection:',
  '- after completing meaningful work: a task finished, a bug understood, a decision made;',
  '- before a context switch, so what was just learned outlives the topic that produced it;',
  '- at the end of a session;',
  '- whenever the user states a preference or a fact about their system that should outlive this conversation.',
  '',
  'Prefer an observation over a transcript when the value is the conclusion rather than the exchange.',
  'A good observation states the conclusion, the reason behind it, and the concrete names',
  'involved (files, commands, decisions). A later session gets that line and nothing around it.',
  'Reflect once per unit of work instead of batching a whole session into one call at the end.',
  '',
  'Send `provenance` when this experience stands in a relation to memories already stored.',
  '`supersedes` names ids this experience corrects, and routes the correction to lineage; it',
  'closes nothing on its own. `derived_from` names ids this experience came from, so two claims',
  'that share a source stop reading as two independent witnesses. `confirmations` records who',
  'confirmed a stored memory and where that is written down: it is evidence a later reader',
  'weighs, and nothing waits on it.',
  '',
  'Send `feedback` to say what became of a pack you were served. `received` says it reached you,',
  'which assembling one cannot establish; `used` names the memories you acted on, and is recorded',
  'as your own report rather than as confirmation that they are true. Both are recorded once per',
  'statement and neither changes what recall ranks.',
  'Intake returns as soon as the experience is durable; extraction runs afterward, so the call is fast',
  'and never blocks the work it describes. Credentials are redacted before anything is stored, and',
  'sending the same payload twice returns the original episode rather than storing it again.',
].join('\n');

export const SOURCE_SEARCH_DESCRIPTION = [
  'Find a literal phrase in the raw conversations this substrate captured, whether or not',
  'anything was ever extracted from them. This is a tool for looking something up, not a',
  'replacement for recall: recall is what grounds you in what came before, and this is what you',
  'reach for when you need the exact words.',
  '',
  'Call source_search when you know roughly what was said and need the passage itself: an exact',
  'command, an error string, a phrase from an earlier conversation. Terms are matched literally',
  'and combined; wrap words in double quotes to require them as a phrase.',
  '',
  'Every answer says what the index could not cover. `corpus.truncated_documents` counts parts',
  'whose stored text is a prefix, so a phrase past that prefix is absent from the index while',
  'the source itself still holds it; read the whole part with the `source` tool. An empty result',
  'is not proof the phrase was never said. Use `as_of` to ask about what was true at a past date',
  'and `knew_at` to ask what memory held then.',
].join('\n');

export const SOURCE_DESCRIPTION = [
  'Read the captured parts behind one source: pass a source id, an original turn id, or a part',
  'address. Ids that came back from recall or from source_search resolve here even after the',
  'graph projection behind them is gone.',
  '',
  'Long sources come back over pages. A page is never the whole source: when `continuation` is',
  'present, more parts follow, and a judgment that needs all of it has to read all of it.',
].join('\n');

/**
 * MCP `instructions`: the in-protocol twin of the CLAUDE.md usage protocol that ships with
 * the server. A client that surfaces server instructions gets the cadence rule without the
 * user pasting anything.
 */
export const USAGE_PROTOCOL = [
  "Aion is this agent's persistent memory across sessions.",
  '',
  'Recall at the start of a session and before each new topic; reflection after meaningful work,',
  'before a context switch, and at session end. Recall costs little and answers honestly when it',
  'has nothing. Memory that is never written cannot be recalled, so the reflection call is what',
  'makes the next session cheaper than this one.',
].join('\n');
