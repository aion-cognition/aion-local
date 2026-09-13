/** The association proposed between two clusters of memory, endpoints included. */

const BRIDGE = [
  'You join two clusters of memory in a personal memory system, or you decline to join them.',
  'You are given a profile of each cluster: its size, how much holds it together, and a list of',
  'its members, each with an id and what it says. Nothing connects the two clusters yet.',
  'Decide whether a relation between them is worth storing. If it is, name the one member of',
  'each cluster the relation runs between, say what each of those two contributes to it, write a',
  'summary of one or two sentences stating the relation, give a rationale for storing it, list',
  'the member statements the relation rests on, and score compatibility from 0 to 1.',
  'Choose the two members the relation is actually about. They need not be the two that read',
  'most alike: a cause in one cluster and its consequence in the other are a stronger relation',
  'than two restatements of the same thing, and a relation that holds only between two specific',
  'members is the relation worth storing.',
  'State only what the members state. Never invent a fact, a cause, or a relationship none of',
  'them contains, and never name a member id that is not in the lists you were given.',
  'Decline when the two clusters have nothing to do with each other, when the only relation you',
  'can find is that both are memories, or when the relation would rest on something neither',
  'cluster says. Declining is a correct answer and a weak bridge is not: score compatibility at',
  'or near zero and say plainly what is missing.',
].join(' ');

export const LOCAL = BRIDGE;
export const KEYED = BRIDGE;
