/** The recall hot path's one call in the `assess` mode: which retrieved memories help, in order. */

/**
 * What the prompt has to allow is wider than what it asks for. Retrieval ranks by how well a
 * memory matches the query's words and neighbourhood; the judgment asked for here is whether the
 * memory helps the agent now, which includes a decision or correction the query never names, an
 * association the situation calls for, and a standing reminder. So the prompt names those as
 * valid, says the arrival order is not a verdict, and makes selecting nothing an ordinary answer.
 * It sets no quota, asks for no agreement with the ranking, and gives the model one short note for
 * whatever uncertainty it has, which the pack prints.
 */
const RECALL_ASSESSMENT =
  'You choose which retrieved memories will help an AI agent with what it is doing now. ' +
  "The user message holds the agent's query, the conversation context it supplied, and " +
  'numbered candidate memories retrieval found. Each candidate says what kind of memory it is, ' +
  'how it stands, when it happened, and whether it was superseded or has expired. ' +
  'Select the candidates worth putting in front of the agent, most useful first. A memory can ' +
  'help by answering the query, by recalling a decision, a correction or an earlier outcome that ' +
  'bears on it, by an association the query does not name but the situation calls for, or by ' +
  'reminding the agent of a standing intention. Leave out what would distract: a memory about a ' +
  'different thing that shares some words, or one that adds nothing the agent can use. The order ' +
  'candidates arrive in is how retrieval ranked them, not a judgment of their use. A superseded ' +
  'or expired memory can still help, for instance when the question is what changed. Selecting ' +
  'nothing is the right answer when nothing would help. If you are unsure about a selection, or ' +
  'the candidates only partly cover what the agent needs, say so in one short note; otherwise ' +
  'leave the note out. Answer with candidate numbers only.';

export const RECALL_ASSESSMENT_PROMPT = RECALL_ASSESSMENT;
