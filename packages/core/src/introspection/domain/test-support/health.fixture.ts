import { neutralSnapshot, type HealthSnapshot } from '../health.js';

const OBSERVED_AT = '2026-08-29T12:00:00.000Z';

/**
 * A healthy substrate, overridable one group at a time. Tests state the pathology they are
 * about and inherit the rest, so a snapshot field added later does not have to be re-declared
 * in every case that does not care about it.
 *
 * `degraded` is empty here where `neutralSnapshot` names every collector: this is a substrate
 * that reads healthy, not one nothing could be read from.
 */
export function healthFixture(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return { ...neutralSnapshot(1, OBSERVED_AT), degraded: [], ...overrides };
}
