/**
 * Claim extraction: the nine cognitive types, the per-type fields, and the key a fact-bearing
 * claim asserts under.
 *
 * Both routes read this one text. A denser keyed variant carrying the goal/plan restatement rule
 * in place of the second validation call was written and measured over the nine harness fixtures:
 * it extracted 25 nodes in its first form and 28 after a repair, against 32 for these words, and
 * lost a type from five fixtures. Fewer words cost claims here, so the remote model reads the
 * same spelled-out rules the local one does.
 */

const EXTRACTION = [
  'You extract cognitive structure from a memory episode recorded by an AI coding agent:',
  'goals, plans, decisions, insights, concepts, contexts, events, patterns, and trends the episode actually contains.',
  'Most episodes do not contain all nine kinds, and many contain only one or two of them.',
  'Extract a type only when the episode gives it real, distinct content; return nothing at',
  'all for a type the episode has no content for. Returning fewer than nine nodes, or zero,',
  'is the normal and expected outcome: do not add a node merely to cover a type, and do not',
  'add a second node restating one you already extracted under a different type.',
  'Give each node a type from that list and a one-sentence text grounded in the episode.',
  'Those nine are the only types that exist; a node whose type is not one of them is discarded,',
  'so record what would have been a tenth type under whichever of the nine fits it best.',
  'For a goal, add status (active, completed, or abandoned) and priority (low, medium, or high) when the episode states them.',
  'For a plan, add status (active, completed, or abandoned) when the episode states it.',
  'For a decision, add a one-sentence rationale when the episode gives one.',
  "A goal or plan must state something beyond the episode's own summary line; if it would",
  'only restate that summary in different words, leave it out.',
  'For a decision, insight, concept, or event only, add three more fields when the episode',
  'makes them plain: subject_entity, the one thing the claim asserts about, spelled the way the',
  'episode spells it; aspect, the attribute of that thing being asserted, never its value, so',
  '"supersede mode" and not "unanimous", and "retry limit" and not "five"; and temporal_class,',
  'which is reading for a measurement that goes stale on its own, standing for something that',
  'holds until it is corrected, and trend for a direction rather than a value.',
  'Leaving all three out is normal and expected: give them for a claim that states one attribute',
  'of one named thing, and omit them for everything else.',
  'For a goal or plan, give subject_entity and aspect on the same terms and no temporal_class:',
  'the thing the intention is about, and the attribute of it the intention means to settle.',
  'For a goal or plan only, add trigger_after as an ISO 8601 date or datetime when the episode',
  'names a moment the intention waits for and that moment resolves to a calendar date; omit it',
  'for a condition with no date in it ("after the reset lands") and for everything else.',
].join(' ');

export const LOCAL = EXTRACTION;
export const KEYED = EXTRACTION;
