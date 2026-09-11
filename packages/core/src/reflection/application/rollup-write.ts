import type { Driver } from 'neo4j-driver';

import { attachContentVectors } from './vectors.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import { NARRATIVE_PROPERTIES } from '../../infrastructure/graph/narrative-queries.js';
import { ROLLUP_WINDOW_PROPERTY } from '../../infrastructure/graph/narrative-rollup-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';
import type { RollupScope } from '../domain/rollup.js';

/**
 * What a calendar summary stores, and the one step that is allowed to fail after it lands.
 *
 * The graph effects themselves belong to `calendar-rollup-publication.ts`: a summary is written,
 * absorbs its members and closes their edges inside one guarded publication, so the shape of the
 * node is all this file still owns.
 */

export const ROLLUP_EXTRACTION_METHOD = 'narrative_rollup';

export const ROLLUP_SIGNALS = ['compression'];
export const ROLLUP_PROVENANCE = [ROLLUP_EXTRACTION_METHOD];

export type RollupWriteDeps = {
  readonly driver: Driver;
  readonly provider: Provider;
  readonly logger: Logger;
  /** The durable records the pass reads its coverage contract and family proof out of. */
  readonly db?: SqliteHandle;
};

export type RollupWrite = {
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
};

/** The stored shape of a calendar summary, built where the publication that writes it can read it. */
export function rollupProperties(input: RollupWrite): GraphProperties {
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
