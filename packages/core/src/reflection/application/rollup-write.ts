import type { Driver } from 'neo4j-driver';

import { attachContentVectors } from './vectors.js';
import {
  supersedeInTransaction,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { closeNarrativeEdgesInTransaction } from '../../infrastructure/graph/narrative-edge-queries.js';
import {
  NARRATIVE_PROPERTIES,
  SUMMARIZED_BY_TYPE,
} from '../../infrastructure/graph/narrative-queries.js';
import { ROLLUP_WINDOW_PROPERTY } from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';
import type { RollupScope } from '../domain/rollup.js';

/**
 * Everything a rollup pass writes, and the one thing it records instead of writing.
 *
 * Split out of `narrative-rollup.ts` because that file reached the line cap: the decision half
 * (which windows are closed, which of them fit, which of them a model is asked about) and the
 * write half are separable, and the write half is the part with the graph in it.
 */

export const ROLLUP_EXTRACTION_METHOD = 'narrative_rollup';

export const ROLLUP_SIGNALS = ['compression'];
export const ROLLUP_PROVENANCE = [ROLLUP_EXTRACTION_METHOD];

export type RollupWriteDeps = {
  readonly driver: Driver;
  readonly provider: Provider;
  readonly logger: Logger;
  /**
   * Carried for the callers that hold one. The refused-window record moved onto the overview
   * family's own attempt row when that family got a publication, so nothing here writes it.
   */
  readonly db?: SqliteHandle;
};

export type RollupWrite = {
  readonly rollupId: string;
  readonly scope: RollupScope;
  readonly windowKey: string;
  readonly version: number;
  readonly coverageKey: string;
  readonly memberIds: readonly string[];
  readonly summary: string;
  readonly narrative: string;
  readonly citations: readonly string[];
  readonly sentenceCount: number;
  readonly spanStart?: Date;
  readonly spanEnd?: Date;
  readonly occurredAt: Date;
  readonly now: Date;
};

function rollupProperties(input: RollupWrite): GraphProperties {
  return {
    [MEMORY_PROPERTIES.summary]: input.summary,
    [MEMORY_PROPERTIES.text]: input.narrative,
    [MEMORY_PROPERTIES.extractionMethod]: ROLLUP_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.citations]: [...input.citations],
    [NARRATIVE_PROPERTIES.sentenceCount]: input.sentenceCount,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [NARRATIVE_PROPERTIES.scope]: input.scope,
    [ROLLUP_WINDOW_PROPERTY]: input.windowKey,
    [NARRATIVE_PROPERTIES.version]: input.version,
    [NARRATIVE_PROPERTIES.coverageKey]: input.coverageKey,
    [NARRATIVE_PROPERTIES.coverageCount]: input.memberIds.length,
    // Every member of the window is rendered, and a window the member read may have cut short
    // is not rolled up at all, so a stored rollup saw the whole of what it claims to cover.
    [NARRATIVE_PROPERTIES.coverage]: 1,
    [NARRATIVE_PROPERTIES.spanStart]: input.spanStart,
    [NARRATIVE_PROPERTIES.spanEnd]: input.spanEnd,
  };
}

/**
 * The node and the member edges in one transaction, mirroring a session narrative's own write:
 * `(member)-[:SUMMARIZED_BY]->(rollup)`, counted zero because a structural fact repeated is not
 * an observation repeated.
 */
export async function writeRollup(deps: RollupWriteDeps, input: RollupWrite): Promise<void> {
  await inWriteTransaction(deps.driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: 'Narrative',
      id: input.rollupId,
      now: input.now,
      occurredAt: input.occurredAt,
      properties: rollupProperties(input),
    });

    for (const memberId of input.memberIds) {
      await upsertEdgeInTransaction(tx, {
        type: SUMMARIZED_BY_TYPE,
        sourceId: memberId,
        targetId: input.rollupId,
        strength: 1,
        confidence: 1,
        signals: ROLLUP_SIGNALS,
        provenance: ROLLUP_PROVENANCE,
        count: 0,
        now: input.now,
      });
    }
  });
}

/**
 * Closing what the rollup absorbed, and any earlier version of the rollup itself. Both go
 * through supersession, so both are reversible by `aion unsupersede` and both stay readable
 * through `as_of`. `validUntil` is the world time the rollup covers up to rather than the moment
 * the sweep ran.
 *
 * The absorbed members' own summarization edges close in the same transaction, the way a
 * session close ends the ones into the version it replaces. A rollup absorbs a whole day of
 * session narratives at once, so leaving those edges open would make this the largest producer
 * of exactly the residue the write path stopped creating, and the episodes underneath would go
 * on traversing to a narrative the rollup has already replaced.
 *
 * WHAT IT ABSORBS IS THE LEGACY SESSION FAMILY AND NOTHING ELSE. A chunk revision carries the
 * `chunk` scope and is not in the member read at all, so no overview here can take one; C3 §6's
 * rule that an overview closes its own prior head and never a member chunk is satisfied by that
 * separation, and retiring the legacy absorption belongs with the overview family's own
 * publication and the cutover that ends the legacy family.
 */
export async function closeInto(
  deps: RollupWriteDeps,
  rollupId: string,
  ids: readonly string[],
  now: Date,
  validUntil: Date,
): Promise<number> {
  const absorbed = ids.filter((oldId) => oldId !== rollupId);
  if (absorbed.length === 0) {
    return 0;
  }

  await inWriteTransaction(deps.driver, async (tx) => {
    for (const oldId of absorbed) {
      await supersedeInTransaction(tx, {
        oldId,
        newId: rollupId,
        now,
        validUntil,
        signals: ROLLUP_SIGNALS,
        provenance: ROLLUP_PROVENANCE,
      });
    }
    await closeNarrativeEdgesInTransaction(tx, {
      narrativeIds: absorbed,
      validUntil,
      txUntil: now,
    });
  });

  return absorbed.length;
}

export async function attachVector(
  deps: RollupWriteDeps,
  rollupId: string,
  text: string,
): Promise<void> {
  try {
    await attachContentVectors(deps.driver, deps.provider, [{ id: rollupId, text }]);
  } catch (err) {
    deps.logger.warn({ err, rollupId }, 'rollup vector deferred; the rollup is stored');
  }
}
