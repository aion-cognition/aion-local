import { BATCH_SETTLEMENT_OPERATION } from './operations/batch-settlement.js';
import type { Config } from '../../infrastructure/config/schema.js';
import { pendingReleases } from '../../infrastructure/providers/batch-release.js';
import { providerKeyPresent } from '../../infrastructure/providers/routing.js';
import { GENERATION_PROVIDERS } from '../../infrastructure/providers/types.js';
import { waitingBatchWork } from '../../infrastructure/sqlite/batch-work.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { operationStats } from '../../infrastructure/sqlite/introspection-counters.js';
import { readSubstratePairing } from '../../infrastructure/sqlite/publication-control.js';
import { readSpendDay } from '../../infrastructure/sqlite/spend-ledger.js';
import type { BatchBlock, BatchDemand } from '../domain/batch-settlement.js';

/**
 * The batch lane's census, read from SQLite alone: the work rows, the deletions the ops ledger
 * records as failed, the pump's own run record, the day's spend and which keys are set. Every input is durable, so the waits it reports survive a
 * restart, and none of it reaches a vendor, so a tick learns what the lane owes without asking
 * anyone whether a job finished.
 *
 * The rule for who can act mirrors the pump's own. Submission needs the selected provider's key
 * and headroom under the day's ceiling. Reading a job needs the key of the provider that took it,
 * whatever is selected now, and so does retrying a deletion at that provider. Discarding
 * never-sent work for the other provider needs neither.
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
      releases: 0,
      unkeyedReleases: 0,
      lastCheckedAt,
      localWaitMs: undefined,
      remoteWaitMs: undefined,
      releaseWaitMs: undefined,
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

  // Every deletion is attempted inside a pump pass, so the pass's own stamp is when a failed one
  // was last tried. The ledger's stamp stands in only where the pump has no run record.
  let releases = 0;
  let unkeyedReleases = 0;
  let oldestFailure: string | undefined;
  for (const provider of GENERATION_PROVIDERS) {
    const pending = pendingReleases(db, provider);
    if (!providerKeyPresent(config, provider)) {
      unkeyedReleases += pending.length;
      continue;
    }
    releases += pending.length;
    for (const release of pending) {
      oldestFailure = earlier(oldestFailure, release.failedAt);
    }
  }

  const checkedAt = lastCheckedAt === undefined ? undefined : Date.parse(lastCheckedAt);
  const lastTried = lastCheckedAt ?? oldestFailure;
  return {
    sendable,
    blocked,
    blockedBy: blocked > 0 ? blockedBy : undefined,
    obsolete,
    outstanding,
    unreadable,
    releases,
    unkeyedReleases,
    lastCheckedAt,
    localWaitMs: oldestLocal === undefined ? undefined : waitSince(oldestLocal, checkedAt, now),
    remoteWaitMs: oldestRemote === undefined ? undefined : waitSince(oldestRemote, checkedAt, now),
    releaseWaitMs:
      releases === 0 || lastTried === undefined
        ? undefined
        : Math.max(0, now.getTime() - Date.parse(lastTried)),
    availability: 'measured',
  };
}
