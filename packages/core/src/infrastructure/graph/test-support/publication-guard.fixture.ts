import type { Driver } from 'neo4j-driver';

import {
  PUBLICATION_GUARD_BIRTH_PROPERTY,
  PUBLICATION_GUARD_ID_PROPERTY,
  PUBLICATION_GUARD_LABEL,
} from '../publication-guard.js';

/**
 * Rewrites the guard's birth to `at`, on the same property the guard mints and the birth fence
 * reads. It checks nothing about direction: a caller that must only move a birth earlier
 * enforces that itself.
 */
export async function backdatePublicationGuardBirth(
  driver: Driver,
  substrateId: string,
  at: Date,
): Promise<void> {
  const result = await driver.executeQuery(
    `MATCH (g:${PUBLICATION_GUARD_LABEL} {${PUBLICATION_GUARD_ID_PROPERTY}: $substrateId})
     SET g.${PUBLICATION_GUARD_BIRTH_PROPERTY} = $at
     RETURN count(g) AS moved`,
    { substrateId, at: at.toISOString() },
  );
  const moved = (result.records[0]?.get('moved') as { toNumber(): number } | undefined)?.toNumber();
  if (moved !== 1) {
    throw new Error(`expected one publication guard for ${substrateId}, found ${moved ?? 0}`);
  }
}
