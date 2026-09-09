import { planSourceVerification, type VerificationPlan } from './legacy-verification.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import {
  readLegacyIncidentRelations,
  readLegacyRawNodes,
} from '../../infrastructure/graph/legacy-evidence-queries.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  classifyLegacyRelations,
  type MaterializedLink,
} from '../domain/legacy-materialization.js';

/**
 * Whether one legacy source may have its evidence materialized at all, and what that evidence is.
 *
 * Everything the decision rests on is read inside the operation that holds the guard: the graph
 * projection, the archive proof and the incident enumeration. A source admitted on a reading taken
 * somewhere else is a source proved against a substrate that could have moved since.
 */
export type LegacyAdmissionRequest = {
  readonly sourceId: string;
  readonly archiveRowidLow: number;
  readonly archiveRowidHigh: number;
  readonly relationLimit: number;
  readonly reverify: boolean;
};

export type Admission = {
  readonly admitted: boolean;
  readonly reason: string;
  readonly links: readonly MaterializedLink[];
  readonly verification: VerificationPlan;
};

/**
 * What the enumeration and the records together admit. Anything short of all of it pins.
 *
 * The re-verification happens HERE, inside the operation that holds the guard, and its verdict
 * travels in the plan. A source proved by a pass whose graph read was taken somewhere else is a
 * source proved against a substrate that could have moved since.
 */
export async function admit(
  graph: GraphTransaction,
  db: SqliteHandle,
  payload: LegacyAdmissionRequest,
  now: Date,
): Promise<Admission> {
  const raw = await readLegacyRawNodes(graph, payload.sourceId);
  const verification = planSourceVerification(db, {
    sourceId: payload.sourceId,
    bounds: { low: payload.archiveRowidLow, high: payload.archiveRowidHigh },
    raw,
    now,
    reverify: payload.reverify,
  });
  const pinned = (reason: string): Admission => ({
    admitted: false,
    reason,
    links: [],
    verification,
  });
  if (verification.status !== 'verified') {
    return pinned(verification.reason);
  }
  if (raw === undefined) {
    return pinned('the graph holds no projection of this source');
  }
  const rawIds = [payload.sourceId, ...raw.turns.map((turn) => turn.turnId)];
  const page = await readLegacyIncidentRelations(graph, rawIds, payload.relationLimit);
  if (!page.complete) {
    return pinned('the incident enumeration exceeded its bound');
  }
  const plan = classifyLegacyRelations({
    sourceId: payload.sourceId,
    rawIds,
    relations: page.relations,
  });
  const pin = plan.pins[0];
  if (pin !== undefined) {
    return pinned(pin.reason);
  }
  return {
    admitted: true,
    reason: 'every incident relationship is classified',
    links: plan.links,
    verification,
  };
}
