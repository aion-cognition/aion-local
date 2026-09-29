import { BATCH_SETTLEMENT_OPERATION } from './operations/batch-settlement.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { providerKeyPresent } from '../../infrastructure/providers/routing.js';
import { waitingBatchWork } from '../../infrastructure/sqlite/batch-work.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { operationStats } from '../../infrastructure/sqlite/introspection-counters.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { readSpendDay } from '../../infrastructure/sqlite/spend-ledger.js';
import type { BatchBlock, BatchDemand } from '../domain/batch-settlement.js';

/**
 * The batch lane's census, read from SQLite alone: the work rows, the pump's own run record, the
 * day's spend and which keys are set. Every input is durable, so the waits it reports survive a
 * restart, and none of it reaches a vendor, so a tick learns what the lane owes without asking
 * anyone whether a job finished.
 *
 * The rule for who can act mirrors the pump's own. Submission needs the selected provider's key
 * and headroom under the day's ceiling. Reading a job needs the key of the provider that took it,
 * whatever is selected now. Discarding never-sent work for the other provider needs neither.
 */

function waitSince(oldestAt: string, checkedAt: number | undefined, now: Date): number {
  const since = Math.max(Date.parse(oldestAt), checkedAt ?? Number.NEGATIVE_INFINITY);
  return Math.max(0, now.getTime() - since);
}

function earlier(left: string | undefined, right: string): string {
  return left === undefined || right < left ? right : left;
}

export function readBatchDemand(db: SqliteHandle, config: Config, now: Date): BatchDemand {
  const lastCheckedAt = operationStats(db, BATCH_SETTLEMENT_OPERATION).lastRunAt;
  const substrate = readSubstratePairing(db);
  if (substrate === undefined) {
    // No identity means no batch belongs to this store yet, which is a measured empty lane.
    return {
      sendable: 0,
      blocked: 0,
      blockedBy: undefined,
      obsolete: 0,
      outstanding: 0,
      unreadable: 0,
      lastCheckedAt,
      localWaitMs: undefined,
      remoteWaitMs: undefined,
      availability: 'measured',
    };
  }

  const selected = config.generation.provider;
  let blockedBy: BatchBlock | undefined;
  if (!providerKeyPresent(config, selected)) {
    blockedBy = 'missing_key';
  } else if (readSpendDay(db, now).committedUsd >= config.anthropic.dailyCeilingUsd) {
    blockedBy = 'spent_ceiling';
  }

  let sendable = 0;
  let blocked = 0;
  let obsolete = 0;
  let outstanding = 0;
  let unreadable = 0;
  let oldestLocal: string | undefined;
  let oldestRemote: string | undefined;
  for (const group of waitingBatchWork(db, substrate.substrateId)) {
    if (group.state === 'submitted') {
      if (providerKeyPresent(config, group.provider)) {
        outstanding += group.count;
        oldestRemote = earlier(oldestRemote, group.oldestAt);
      } else {
        unreadable += group.count;
      }
      continue;
    }
    if (group.provider !== selected) {
      obsolete += group.count;
      oldestLocal = earlier(oldestLocal, group.oldestAt);
      continue;
    }
    if (blockedBy !== undefined) {
      blocked += group.count;
      continue;
    }
    sendable += group.count;
    oldestLocal = earlier(oldestLocal, group.oldestAt);
  }

  const checkedAt = lastCheckedAt === undefined ? undefined : Date.parse(lastCheckedAt);
  return {
    sendable,
    blocked,
    blockedBy: blocked > 0 ? blockedBy : undefined,
    obsolete,
    outstanding,
    unreadable,
    lastCheckedAt,
    localWaitMs: oldestLocal === undefined ? undefined : waitSince(oldestLocal, checkedAt, now),
    remoteWaitMs: oldestRemote === undefined ? undefined : waitSince(oldestRemote, checkedAt, now),
    availability: 'measured',
  };
}
