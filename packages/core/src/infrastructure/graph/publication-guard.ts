import neo4j, { type Driver } from 'neo4j-driver';

import type { SqliteHandle } from '../sqlite/database.js';
import { beginSubstratePairing, completeSubstratePairing } from '../sqlite/publication-control.js';

/**
 * The publication guard node: one node per paired substrate, on a label of its own.
 *
 * It carries neither the base node label nor the memory label, because it is not a memory and
 * nothing that walks the graph should reach it. Its uniqueness constraint is declared by a
 * migration like every other schema object, and the constraint statement is safe to replay.
 * The node itself is not: the migration runner re-runs every statement on every open, and a
 * bare `MERGE` there would quietly mint a replacement for a guard that went missing after the
 * substrate was initialized. Creation is therefore conditional on the substrate's own
 * bootstrap marker, which only an unfinished initial pairing leaves open.
 */
export const PUBLICATION_GUARD_LABEL = 'PublicationGuard';

export const PUBLICATION_GUARD_ID_PROPERTY = 'substrate_id';

/** The substrate's birth: set once when the guard is minted, and read by the intake birth fence. */
export const PUBLICATION_GUARD_BIRTH_PROPERTY = 'created_at';

export const PUBLICATION_GUARD_CONSTRAINT = 'publication_guard_substrate_id_unique';

export const PUBLICATION_GUARD_CONSTRAINT_STATEMENT = `CREATE CONSTRAINT ${PUBLICATION_GUARD_CONSTRAINT} IF NOT EXISTS FOR (n:${PUBLICATION_GUARD_LABEL}) REQUIRE n.${PUBLICATION_GUARD_ID_PROPERTY} IS UNIQUE`;

const MERGE_GUARD = `MERGE (g:${PUBLICATION_GUARD_LABEL} {${PUBLICATION_GUARD_ID_PROPERTY}: $substrateId})
  ON CREATE SET g.${PUBLICATION_GUARD_BIRTH_PROPERTY} = $now, g.protocol_version = $protocolVersion
  RETURN g.${PUBLICATION_GUARD_ID_PROPERTY} AS substrateId`;

const COUNT_GUARDS = `MATCH (g:${PUBLICATION_GUARD_LABEL} {${PUBLICATION_GUARD_ID_PROPERTY}: $substrateId})
  RETURN count(g) AS present`;

/**
 * What one bootstrap call did.
 *
 * `created` means this call minted the guard and closed the pairing. `joined` means the
 * substrate was already initialized and its guard is there. `missing` means the substrate was
 * initialized and the guard is gone, which is an inconsistency for the caller to report: the
 * receipt it held is unrecoverable, and minting a fresh guard would hide that.
 */
export type PublicationGuardBootstrap = {
  readonly substrateId: string;
  readonly outcome: 'created' | 'joined' | 'missing';
};

export async function publicationGuardExists(
  driver: Driver,
  substrateId: string,
): Promise<boolean> {
  const result = await driver.executeQuery(COUNT_GUARDS, { substrateId });
  const [record] = result.records;
  if (record === undefined) {
    return false;
  }
  return (record.get('present') as { toNumber(): number }).toNumber() > 0;
}

/**
 * Mints the guard while the substrate's initial pairing is still open, and reports rather than
 * repairs once it is closed. Running it again on an initialized substrate is a read.
 */
export async function bootstrapPublicationGuard(
  driver: Driver,
  db: SqliteHandle,
  protocolVersion: number,
): Promise<PublicationGuardBootstrap> {
  const pairing = beginSubstratePairing(db, protocolVersion);

  if (pairing.bootstrapState === 'initialized') {
    const present = await publicationGuardExists(driver, pairing.substrateId);
    return { substrateId: pairing.substrateId, outcome: present ? 'joined' : 'missing' };
  }

  await driver.executeQuery(MERGE_GUARD, {
    substrateId: pairing.substrateId,
    now: new Date().toISOString(),
    protocolVersion,
  });
  completeSubstratePairing(db, pairing.substrateId);
  return { substrateId: pairing.substrateId, outcome: 'created' };
}

const READ_GUARD_CREATED_AT = `MATCH (g:${PUBLICATION_GUARD_LABEL} {${PUBLICATION_GUARD_ID_PROPERTY}: $substrateId})
  RETURN g.${PUBLICATION_GUARD_BIRTH_PROPERTY} AS createdAt`;

/**
 * The substrate's own birth: the instant its one `PublicationGuard` node was minted, which the
 * creation-gate above (see the module doc) makes a single, unrepeatable event keyed to this
 * same substrate id. Undefined before the guard exists, which a caller reads as "birth
 * unknown" rather than "born now": nothing can be judged older than a birth nobody has read
 * yet.
 */
export async function readPublicationGuardBirth(
  driver: Driver,
  substrateId: string,
): Promise<Date | undefined> {
  const result = await driver.executeQuery(
    READ_GUARD_CREATED_AT,
    { substrateId },
    {
      routing: neo4j.routing.READ,
    },
  );
  const [record] = result.records;
  const createdAt = record?.get('createdAt') as string | null | undefined;
  if (createdAt === null || createdAt === undefined) {
    return undefined;
  }
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Schema creation belongs to migrations; bootstrap refuses an absent or incompatible constraint. */
export async function publicationGuardSchemaPresent(driver: Driver): Promise<boolean> {
  const result = await driver.executeQuery(
    `SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties
     WHERE name = $name RETURN type, labelsOrTypes, properties`,
    { name: PUBLICATION_GUARD_CONSTRAINT },
    { routing: neo4j.routing.READ },
  );
  const row = result.records[0];
  return (
    result.records.length === 1 &&
    row !== undefined &&
    ['UNIQUENESS', 'NODE_PROPERTY_UNIQUENESS'].includes(String(row.get('type'))) &&
    JSON.stringify(row.get('labelsOrTypes')) === JSON.stringify([PUBLICATION_GUARD_LABEL]) &&
    JSON.stringify(row.get('properties')) === JSON.stringify([PUBLICATION_GUARD_ID_PROPERTY])
  );
}
