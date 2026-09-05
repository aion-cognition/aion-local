/** Pass two over the same pair, arguing the other side of an affirmative first pass. */

/**
 * Leads with the presumption that both statements stay, so the model has to be argued out of
 * that rather than into it, and puts the burden of proof on the closure: name one attribute of
 * the shared subject and two rival values for it, or the earlier statement stands. The first
 * pass carries the opposite lean, and the pair of them is what makes a unanimous answer worth
 * something.
 *
 * The four non-replacement shapes are the ones the measured false positives came in, stated
 * generally rather than as the cases that produced them.
 */
const REVIEW = [
  'You decide one question: is the earlier statement, exactly as written, false now?',
  'Answer earlier_survives true unless it is. Two statements about one subject are usually both',
  'true, and the burden is on the replacement.',
  'Four rules make the earlier statement survive. Each is decisive on its own: where one',
  'applies, answer earlier_survives true and weigh nothing against it.',
  'One. The earlier statement records what a named person noted, wants, prefers, proposed, or',
  'argued. A record of a position is true from the moment it is made, and nothing later can',
  'falsify it: not another person taking the opposite position, and not a decision going the',
  'other way. This rule covers views only, and only two different people. A statement of how',
  'something is, who owns it, where it runs, or what it is set to is a state rather than a',
  'position, even where a person decided it, and a later state does replace it; and one person',
  'changing their own stated view replaces the earlier view.',
  'Two. The newer statement widens, extends, or adds to what the earlier one says, so the',
  'earlier case is still covered by it. Its own wording usually says so: not only X, as well as',
  'X, every X. Incomplete is not false: a statement that is still true but is no longer the',
  'whole picture survives, because the wider rule covers the narrow case it named.',
  'Three. The two statements describe different attributes of the subject, different',
  'environments, or one particular occasion set beside a standing rule. A record of one run,',
  'one measurement, or one meeting stays true after the thing it observed changes. A statement',
  'of how things stand carries no occasion, so a newer statement giving that standing value a',
  'different value replaces it and this rule does not apply.',
  'Four. The newer statement restates the earlier one, summarises it, or is merely more precise',
  'about it.',
  'Only where none of the four applies, and you can name one attribute of the subject with an',
  'old value and a rival new value that cannot both be current, is the earlier statement false.',
  'Separately, and whatever you answered above: is the newer statement a coherent, complete',
  'claim on its own? Answer newer_is_well_formed false when it is a garbled extraction, a',
  'fragment, an instruction with no subject, or a sentence that names things without asserting',
  'anything about them. A statement that asserts nothing replaces nothing, however close the',
  'wording.',
  'Keep reason to one sentence: name the rule that applies, or name the attribute and its two',
  'rival values.',
].join(' ');

export const LOCAL = REVIEW;
export const KEYED = REVIEW;
