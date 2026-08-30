import type { Driver } from 'neo4j-driver';

import { readFirst } from './connection.js';
import { MEMORY_LABEL } from './labels.js';

/**
 * How long one population reading stands before it is read again. The number only sizes the
 * seed budget, and a budget computed from a count thirty seconds old is the same budget: a
 * substrate does not double in a minute, and a per-recall count would put a round trip in
 * front of every seed query to learn nothing new.
 */
const POPULATION_TTL_MS = 30_000;

type PopulationReading = {
  readonly count: number;
  readonly readAt: number;
};

/**
 * Keyed on the driver rather than held as one module value, so two connections (a test
 * substrate and the service, or two test files in one run) never read each other's count, and
 * the reading is collected with the driver that produced it.
 */
const populationByDriver = new WeakMap<Driver, PopulationReading>();

/**
 * Every node carrying the `:Memory` label, unfiltered. Neo4j answers a bare label count from
 * its count store without touching a node, which is what makes this cheap enough to run on a
 * read path; adding a currency or forget predicate would turn it into a scan of the whole
 * substrate. Unfiltered is also the right question: this measures how large the graph is, not
 * how many of its nodes a given read mode would return, and a forgotten node still made the
 * substrate bigger.
 */
export async function countMemoryNodes(driver: Driver): Promise<number> {
  const count = await readFirst(
    driver,
    `MATCH (n:${MEMORY_LABEL}) RETURN count(n) AS population`,
    {},
    (row) => row.population as number,
  );
  return count ?? 0;
}

/** `countMemoryNodes` behind a short-lived per-driver cache. */
export async function memoryPopulation(driver: Driver, now: number = Date.now()): Promise<number> {
  const held = populationByDriver.get(driver);
  if (held !== undefined && now - held.readAt < POPULATION_TTL_MS) {
    return held.count;
  }
  const count = await countMemoryNodes(driver);
  populationByDriver.set(driver, { count, readAt: now });
  return count;
}
