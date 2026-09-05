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

/**
 * The same four survival rules, still decisive one at a time, each carried by one worked pair
 * instead of by the boundary prose the shared text spends most of its words on. The order is the
 * other change: the small model reads the shared text's opening presumption as the whole
 * instruction and answers earlier_survives true on every pair it sees, so the local text asks for
 * the two rival values first and reaches the rules with a candidate replacement in hand. Both
 * answer fields keep their meaning and the closing instruction is the shared text's word for word.
 */
const REVIEW_LOCAL = [
  'You decide one question: is the earlier statement, exactly as written, false now?',
  'Take it in one order. First name the attribute both statements give a value for, and name the',
  'two values. Where the two values cannot both be current, the earlier statement is false: "The',
  'retry limit is three" is false once "The retry limit is now five" is the standing value.',
  'Where you can name no such attribute, the earlier statement survives.',
  'Then check the four rules. Each is decisive on its own: where one applies, answer',
  'earlier_survives true whatever the two values looked like, and weigh nothing against it.',
  'One. The earlier statement records what a named person noted, wanted, preferred, proposed, or',
  'argued. "Ana argued for Postgres" stays true after the team picks MySQL, and after Ben argues',
  'for MySQL: a record of a position is true from the moment it is made. This rule covers views,',
  'and only two different people. Who owns a thing, where it runs, or what it is set to is a state',
  'rather than a position, and a later state does replace it. One person changing their own stated',
  'view replaces the earlier view.',
  'Two. The newer statement widens or adds to what the earlier one says, so the earlier case is',
  'still covered. "Retries are on for the ledger service" survives "Retries are on for every',
  'service". Incomplete is not false.',
  'Three. The two statements describe different attributes of the subject, different environments,',
  'or one occasion beside a standing rule. "Tuesday\'s run took nine minutes" survives "The run',
  'takes four minutes". A statement that names no occasion is a standing value, and a newer value',
  'for it does replace it.',
  'Four. The newer statement restates the earlier one, summarises it, or is merely more precise',
  'about it. "The sync job runs nightly" survives "The sync job runs nightly at 2am".',
  'A newer statement that names the earlier value as gone, replaced, moved, or transferred is a',
  'replacement, and none of the four rules covers it.',
  'Separately, and whatever you answered above: is the newer statement a coherent, complete',
  'claim on its own? Answer newer_is_well_formed false when it is a garbled extraction, a',
  'fragment, an instruction with no subject, or a sentence that names things without asserting',
  'anything about them. A statement that asserts nothing replaces nothing, however close the',
  'wording.',
  'Keep reason to one sentence: name the rule that applies, or name the attribute and its two',
  'rival values.',
].join(' ');

export const LOCAL = REVIEW_LOCAL;
export const KEYED = REVIEW;
