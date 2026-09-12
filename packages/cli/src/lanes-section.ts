import type { Config } from '@aion/core';

import type { Writer } from './output.js';

/**
 * The lanes section of `aion status` and `aion stats`: which self-acting lane is on.
 *
 * Lifted out of `snapshot.ts` unchanged when that file reached the 500-line cap.
 */

/** The longest lane name, so every `MODE:` in the section starts at one column. */
const LANE_NAME_WIDTH = 19;

/**
 * The lanes that act on their own between two ticks of a person looking, with the two-word
 * verdict `aion status` gives every one of them: `acting` or `off`, never a third state a
 * knob's own vocabulary might suggest. `merge_auto`, `proposal_resolution` and
 * `proposal_hygiene` read their one dedicated boolean. The two proposal lanes get a line each
 * because one off does not stop the other: resolution decides an open row on its merits, and
 * hygiene ages out whatever resolution keeps failing on.
 * Supersession has no boolean of its own: `propose` queues everything and
 * closes nothing, so `unanimous` and the legacy `auto` are what "acting" means for it, and the
 * mode name is shown alongside for the same reason `queue` shows a lane's own depth rather
 * than just a total. The cascade's judge tier reads the same way under
 * `AION_ENTITY_MERGE_MODE`, and it is a separate line from `merge_auto` because the two are
 * separate switches: `merge_auto` governs the deterministic tier, which merges whatever the
 * judge tier is doing. Tier 3 only acts when its kill switch is on and its own mode knob says
 * `act`; `propose` records a recommendation and runs nothing, which reads as `off` here for
 * the same reason it reads as `off` in `docs/operations.md`. `keyed_close` is an eighth
 * switch, independent of `supersedeMode`: it runs inside a different stage's write and reads
 * the same way supersession does, `off` or the mode it routes into.
 */
function laneMode(acting: boolean): 'acting' | 'off' {
  return acting ? 'acting' : 'off';
}

export function renderLanes(config: Config, write: Writer): void {
  write('');
  write('lanes');
  write(
    `  ${'merge_auto'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.autoMerge)}`,
  );

  const { entityMergeMode } = config.reflection;
  const entityMergeActing = entityMergeMode !== 'propose';
  const entityMergeDetail = entityMergeActing ? ` (${entityMergeMode})` : '';
  write(
    `  ${'entity_dedup'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(entityMergeActing)}${entityMergeDetail}`,
  );

  const supersessionMode = config.reflection.supersedeMode;
  const supersessionActing = supersessionMode !== 'propose';
  const supersessionDetail = supersessionActing ? ` (${supersessionMode})` : '';
  write(
    `  ${'supersession'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(supersessionActing)}${supersessionDetail}`,
  );

  const { keyedCloseMode } = config.reflection;
  const keyedCloseActing = keyedCloseMode !== 'off';
  const keyedCloseDetail = keyedCloseActing ? ` (${keyedCloseMode})` : '';
  write(
    `  ${'keyed_close'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(keyedCloseActing)}${keyedCloseDetail}`,
  );

  write(
    `  ${'proposal_resolution'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.proposalResolution)}`,
  );

  write(
    `  ${'proposal_hygiene'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.proposalHygiene)}`,
  );

  write(
    `  ${'claim_dedup'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.claimDedup)}`,
  );

  const tier3Acting = config.maintenance.tier3 && config.maintenance.tier3Mode === 'act';
  write(`  ${'tier3'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(tier3Acting)}`);
}
