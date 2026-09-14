import type { Driver } from 'neo4j-driver';

import { bridgeTraversalEvidence, summarizeBridgeTraversal } from './bridge-traversal-sense.js';
import { coOccursDensityEvidence, readCoOccursDensity } from './co-occurs-density-sense.js';
import {
  compatibilityCalibrationEvidence,
  readCompatibilityCalibration,
} from './compatibility-calibration-sense.js';
import { judgmentDurabilityEvidence, readJudgmentDurability } from './judgment-durability-sense.js';
import {
  resonanceUsefulnessEvidence,
  summarizeResonanceUsefulness,
} from './resonance-usefulness-sense.js';
import type { Logger } from '../../../infrastructure/logging/logger.js';
import type { SqliteHandle } from '../../../infrastructure/sqlite/database.js';

/**
 * The five introspection senses, folded into one evidence block for the tier-3 prompt.
 *
 * Every sense runs behind its own try/catch: a collector that throws costs this cycle's line
 * from that one sense and nothing else. Nothing here is a score, a threshold, or an input to
 * `acceptTier3Proposal` — the whole point of this module is to hand the model evidence with its
 * limits stated, never to decide anything on its behalf.
 */

type SenseName =
  | 'bridge_traversal'
  | 'resonance_usefulness'
  | 'judgment_durability'
  | 'compatibility_calibration'
  | 'co_occurs_density';

function guarded(
  logger: Logger,
  sense: SenseName,
  run: () => readonly string[],
): readonly string[] {
  try {
    return run();
  } catch (err) {
    logger.warn({ err, sense }, 'introspection sense read failed');
    return [];
  }
}

async function guardedAsync(
  logger: Logger,
  sense: SenseName,
  run: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  try {
    return await run();
  } catch (err) {
    logger.warn({ err, sense }, 'introspection sense read failed');
    return [];
  }
}

export async function readSenseEvidence(
  driver: Driver,
  db: SqliteHandle,
  now: Date,
  logger: Logger,
): Promise<readonly string[]> {
  const lines: string[] = [];

  lines.push(
    ...guarded(logger, 'bridge_traversal', () => {
      const line = bridgeTraversalEvidence(summarizeBridgeTraversal(db));
      return line === undefined ? [] : [line];
    }),
  );
  lines.push(
    ...guarded(logger, 'resonance_usefulness', () => {
      const line = resonanceUsefulnessEvidence(summarizeResonanceUsefulness(db));
      return line === undefined ? [] : [line];
    }),
  );
  lines.push(
    ...(await guardedAsync(logger, 'judgment_durability', async () =>
      judgmentDurabilityEvidence(await readJudgmentDurability(driver, db, now)),
    )),
  );
  lines.push(
    ...(await guardedAsync(logger, 'compatibility_calibration', async () =>
      compatibilityCalibrationEvidence(await readCompatibilityCalibration(driver, db, now)),
    )),
  );
  lines.push(
    ...guarded(logger, 'co_occurs_density', () => coOccursDensityEvidence(readCoOccursDensity(db))),
  );

  return lines;
}
