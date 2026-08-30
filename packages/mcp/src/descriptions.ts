/**
 * The descriptions are tuned artifacts, not documentation. A tool-based memory
 * only works if the agent calls it, so each description states when to invoke as much as
 * what the tool does, and the version travels with every tool definition (`_meta`) so
 * observed cadence can be attributed to the text that produced it.
 *
 * Bump `DESCRIPTIONS_VERSION` on every edit to any string in this file.
 */
export const DESCRIPTIONS_VERSION = 1;

/** The `_meta` key the version is published under, so a cadence report can group by it. */
export const DESCRIPTIONS_VERSION_META_KEY = 'aion/descriptions_version';

export const RECALL_TOOL_NAME = 'recall';
export const REFLECTION_TOOL_NAME = 'reflection';

export const RECALL_TITLE = 'Recall memory';
export const REFLECTION_TITLE = 'Store experience';

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
  'recent turns) when you have it — it sharpens what comes back. Use `as_of` to ask what was true',
  'at a past date, `knew_at` to ask what memory held at a past date.',
].join('\n');

export const REFLECTION_DESCRIPTION = [
  'Store what just happened in persistent memory so a later session can recall it. Send raw',
  '`turns`, the `tool_executions` behind them, and/or `observations` — distilled notes stating a',
  'conclusion, a decision and its reason, or something learned.',
  '',
  'Call reflection:',
  '- after completing meaningful work: a task finished, a bug understood, a decision made;',
  '- before a context switch, so what was just learned outlives the topic that produced it;',
  '- at the end of a session;',
  '- whenever the user states a preference or a fact about their system that should outlive this conversation.',
  '',
  'Prefer an observation over a transcript when the value is the conclusion rather than the exchange.',
  'Intake returns as soon as the experience is durable; extraction runs afterward, so the call is fast',
  'and never blocks the work it describes. Credentials are redacted before anything is stored, and',
  'sending the same payload twice returns the original episode rather than storing it again.',
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
