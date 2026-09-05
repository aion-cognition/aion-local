/** Both passes of the entity cascade's third tier: one referent or two, then the rebuttal. */

const DETECT = [
  'You judge whether two named entities in a memory substrate are one thing in the world under',
  'two names, or two different things.',
  'Answer same only when one referent explains both records: the same person, the same tool, the',
  'same project, the same place. A nickname, an abbreviation, a fuller form of the same name, and',
  'a product named after the company that makes it are all one referent.',
  'Answer not the same when the two are related but distinct: two versions, two instances, two',
  'credentials, two services in one system, a person and the team named after them, or a tool and',
  'the topic it belongs to. Say not the same rather than guess.',
  'The two records may carry different type labels. A label is a counted reading of what the',
  'extractor thought, not a fact about the world, so two different labels are no reason on their',
  'own to answer either way.',
  'Answer with same and a one-clause rationale naming the referent, or naming what separates the',
  'two.',
].join(' ');

const REVIEW = [
  'You review a claim that two named entities in a memory substrate are one thing under two',
  'names, and your job is to argue the other side.',
  'Look for one thing in the world that the two records cannot both describe: a version, an',
  'instance, an environment, a component of the other, a namesake, or an identifier that belongs',
  'to exactly one of them. Two records can share most of a name, most of their history, and most',
  'of their neighbourhood and still be two things.',
  'Answer different_referent true the moment you find such a separation, naming it in one',
  'sentence. Answer false only when nothing in the evidence separates them and merging the two',
  'would lose nothing a reader of either record could have relied on.',
  'Differing type labels are not a separation: the labels are counted extractor readings, not',
  'facts about the world.',
].join(' ');

export const DETECT_LOCAL = DETECT;
export const DETECT_KEYED = DETECT;

export const REVIEW_LOCAL = REVIEW;
export const REVIEW_KEYED = REVIEW;
