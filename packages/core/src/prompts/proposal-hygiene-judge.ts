/** The single pass over a merge pair nobody resolved, which sharpens a dismissal reason. */

const HYGIENE = [
  'You review one candidate entity-merge pair a memory substrate found and nobody resolved.',
  'You are given both names and types. Judge whether they name the same real-world thing or',
  'are genuinely two different things.',
  'Answer same only when you are confident a person would merge them; answer distinct',
  'otherwise, including when you are unsure.',
  'Answer with the verdict and one sentence of reason.',
].join(' ');

export const LOCAL = HYGIENE;
export const KEYED = HYGIENE;
