import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendApiCall } from '../../sqlite/api-usage.js';
import { openSqliteHandle, type SqliteHandle } from '../../sqlite/database.js';
import { getMeta, setMeta } from '../../sqlite/meta.js';
import { GenerationCeilingReachedError } from '../errors.js';
import type { FrameOverride } from '../request-blocks.js';
import { GenerationSpendGuard, type SpendingGuard } from '../spending.js';
import type { ApiCall } from '../types.js';

/**
 * The one spending guard every F3 battery producer routes through, so a campaign that spans
 * several `.int.test.ts` files still holds one ceiling rather than one per file.
 *
 * `TEST_AION_CAMPAIGN_LEDGER` names a durable sqlite file the campaign runner opens before the
 * suite starts and every battery file reads the same path from. Absent, this opens its own file
 * under the OS temp directory rather than `:memory:`: a standalone run of one battery file still
 * gets a real, file-backed ledger for the life of that process, which is what makes the guard a
 * safety net even outside a coordinated campaign run. Either way the file is never `:memory:`,
 * because a fresh in-process ledger on every `beforeAll` would let a retried battery spend the
 * ceiling again on each attempt.
 *
 * `openSqliteHandle` runs the full schema migration (`generation_spend` included), so this file
 * is a complete, ordinary substrate database rather than a bespoke ledger shape.
 */

export type CampaignGuardHandle = {
  readonly guard: SpendingGuard;
  readonly ledgerPath: string;
  readonly db: SqliteHandle;
  /** The lifetime cap this handle holds against, read off the ledger. Absent where none is set. */
  readonly campaignBudgetUsd: number | undefined;
  /** Closes the sqlite connection. Never deletes the file: the ledger outlives the process. */
  close(): void;
};

const CAMPAIGN_LEDGER_ENV_VAR = 'TEST_AION_CAMPAIGN_LEDGER';

/**
 * The lifetime budget, stored on the ledger file rather than held by whichever handle happened
 * to declare it.
 *
 * A campaign spans several `.int.test.ts` files, several processes and a UTC rollover, and each
 * of those opens its own handle. A cap that lived only in the opening call's closure governed
 * the coordinator's handle and nothing else: a battery file reopening the same path got a
 * daily-only guard, and a zero campaign budget did not bind it. Writing the number into the
 * ledger makes the cap a property of the campaign, so every later opener reads the same one.
 */
const CAMPAIGN_BUDGET_META_KEY = 'f3_campaign_budget_usd';

/**
 * The budget this ledger is bound by after the caller's own figure is folded in.
 *
 * Both numbers narrow and neither raises: a battery file that named a larger budget than the
 * coordinator's cannot buy itself headroom, and a coordinator reopening a spent ledger under a
 * smaller budget tightens it. The result is written back, so the next opener of this file reads
 * the narrowest figure any participant has named.
 */
function adoptCampaignBudget(
  db: SqliteHandle,
  declaredUsd: number | undefined,
): number | undefined {
  const storedRaw = getMeta(db, CAMPAIGN_BUDGET_META_KEY);
  const stored = storedRaw === undefined ? undefined : Number(storedRaw);
  const known = [stored, declaredUsd].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  );
  if (known.length === 0) {
    return undefined;
  }
  const budget = Math.min(...known);
  if (stored !== budget) {
    setMeta(db, CAMPAIGN_BUDGET_META_KEY, String(budget));
  }
  return budget;
}

/** A private, unique fallback path, used only where no campaign runner named a shared one. */
function standaloneLedgerPath(): string {
  return join(tmpdir(), `aion-f3-standalone-ledger-${randomUUID()}.sqlite`);
}

export function campaignLedgerPath(): string {
  const configured = process.env[CAMPAIGN_LEDGER_ENV_VAR]?.trim();
  return configured !== undefined && configured.length > 0 ? configured : standaloneLedgerPath();
}

/**
 * The advisor/judge-comparison frame condition, named by the campaign runner rather than by a
 * knob any deployment reads. `request-blocks.ts`'s `FrameOverride` is already a test-only seam
 * ("no knob reads it and the service never sets it"); this is the one place a battery file reads
 * it from the environment, so a coordinated run drives every battery through the same two
 * conditions without a second, competing switch.
 *
 * `TEST_AION_FRAME_OVERRIDE=none` selects the no-frame condition. Unset or any other value leaves
 * `frameOverride` undefined, which is the shipped condition: the surface's own allocation
 * decides, exactly as a battery run outside this campaign already behaves.
 */
const FRAME_OVERRIDE_ENV_VAR = 'TEST_AION_FRAME_OVERRIDE';

export function campaignFrameOverride(): FrameOverride | undefined {
  return campaignFrameFor(campaignCondition());
}

/**
 * Dollars this ledger file has committed over its whole life, every UTC day included. The file
 * is dedicated to one campaign, so the all-days total IS the campaign's total: the same
 * `COALESCE(settled_usd, reserved_usd)` reading `spend-ledger.ts` makes per day, without the
 * day filter that lets a rollover hand back headroom.
 */
export function campaignCommittedUsd(db: SqliteHandle): number {
  const row = db
    .prepare(
      `SELECT COALESCE(sum(COALESCE(settled_usd, reserved_usd)), 0) AS committed
       FROM generation_spend WHERE state <> 'released'`,
    )
    .get() as { committed: number };
  return row.committed;
}

/**
 * The daily guard with a campaign-lifetime cap on top, so a run that crosses 00:00 UTC does not
 * get its headroom back at the rollover.
 *
 * The hold is taken through the daily guard first, then verified against the all-days total
 * with the new reservation already in it; a hold that pushes the campaign past its budget is
 * released before the caller ever sees it. Verifying after the reserve rather than before keeps
 * two concurrent callers from both reading the same headroom: whichever lands second sees the
 * first one's row in the total and releases its own.
 */
function withCampaignBudget(
  daily: GenerationSpendGuard,
  db: SqliteHandle,
  campaignBudgetUsd: number,
): SpendingGuard {
  return {
    hold: (request) => {
      const inner = daily.hold(request);
      if ('refused' in inner) {
        return inner;
      }
      const total = campaignCommittedUsd(db);
      if (total > campaignBudgetUsd) {
        inner.hold.release(request.now);
        return {
          refused: new GenerationCeilingReachedError(
            request.surface,
            total - inner.hold.reservedUsd,
            campaignBudgetUsd,
          ),
        };
      }
      return inner;
    },
    today: (now?: Date) => daily.today(now),
  };
}

/**
 * Opens the shared guard against the durable ledger path. `ceilingUsd` defaults to the shipped
 * W4 figure (`config.anthropic.dailyCeilingUsd`); a caller measuring the guard itself, rather
 * than running a battery, passes a lower number (zero included) to build the no-dispatch control.
 *
 * `campaignBudgetUsd` declares the campaign-lifetime cap. It is stored on the ledger rather than
 * held by this call, so every later handle on the same file holds against it too: a battery file
 * that opens with the ceiling alone, a process that reopens after a restart, and a hold taken on
 * the far side of a UTC rollover all read the same number off the same rows. A shared filename
 * alone never conveyed the cap; this is what makes the file the campaign.
 */
export function openCampaignSpendingGuard(
  ceilingUsd: number,
  campaignBudgetUsd?: number,
): CampaignGuardHandle {
  const ledgerPath = campaignLedgerPath();
  const db = openSqliteHandle({ filePath: ledgerPath });
  const budget = adoptCampaignBudget(db, campaignBudgetUsd);
  const daily = new GenerationSpendGuard({ db, ceilingUsd });
  const guard = budget === undefined ? daily : withCampaignBudget(daily, db, budget);
  return {
    guard,
    ledgerPath,
    db,
    campaignBudgetUsd: budget,
    close: () => {
      db.close();
    },
  };
}

/**
 * The campaign's two frame conditions, named the way the recorded usage rows carry them.
 * `campaignFrameOverride()` decides which one this process is running under.
 */
export type CampaignCondition = 'no-frame' | 'shipped-frame';

/** Both conditions, in the order a two-arm file runs them. */
export const CAMPAIGN_CONDITIONS: readonly CampaignCondition[] = ['no-frame', 'shipped-frame'];

/**
 * The frame one named condition sends. The single definition both the request and the recorded
 * row come off, so no caller can select one condition's frame and record under the other's name.
 */
export function campaignFrameFor(condition: CampaignCondition): FrameOverride | undefined {
  return condition === 'no-frame' ? { none: true } : undefined;
}

/** The condition this process runs under, for a file the runner drives one condition at a time. */
export function campaignCondition(): CampaignCondition {
  return process.env[FRAME_OVERRIDE_ENV_VAR]?.trim() === 'none' ? 'no-frame' : 'shipped-frame';
}

/**
 * What one producer opening records under: the experiment, the condition this process runs, and
 * the case in progress. Composed into `api_calls.surface` on the shared ledger, so the campaign's
 * own store answers "which case bought this response, under which condition, for what usage"
 * without the answer depending on a per-file array that dies with the process.
 */
export function campaignUsageSurface(
  experiment: string,
  condition: CampaignCondition,
  caseKey: string,
  surface: string,
): string {
  return `f3/${experiment}/${condition}/${caseKey}/${surface}`;
}

export type CampaignProducerOptions = {
  /** The matrix row this opening belongs to: `advisor`, `judge-comparison`, and so on. */
  readonly experiment: string;
  readonly ceilingUsd: number;
  /** Declared by the coordinator only. A battery leaves it out and inherits the stored cap. */
  readonly campaignBudgetUsd?: number;
};

/** The case name a context records under until something names one. */
export const UNNAMED_CASE = 'unnamed-case';

/**
 * One condition's frame and its recording identity, handed out together.
 *
 * A file that runs both conditions inside one process took the frame from an explicit arm and
 * the recorded condition from the process environment, so a no-frame request recorded under
 * `shipped-frame`. Here the frame the caller sends and the condition the row carries are read
 * off the same field, so the two cannot disagree, and no reader has to recover the condition by
 * parsing a case label. A file the runner drives one condition at a time keeps using the
 * producer's own `beginCase`/`recordApiCall`, which read the process condition as before.
 */
export type CampaignConditionHandle = {
  readonly condition: CampaignCondition;
  /** Hand this to the client. It is `condition`'s frame, never the process's. */
  readonly frameOverride: FrameOverride | undefined;
  /** Passed to whichever provider this context constructs, alongside the producer's `guard`. */
  readonly recordApiCall: (call: ApiCall) => void;
  /** Names the case rows recorded through THIS context belong to. */
  beginCase(caseKey: string): void;
};

export type CampaignProducerHandle = CampaignGuardHandle &
  CampaignConditionHandle & {
    readonly experiment: string;
    /**
     * A recording identity for a condition this process names itself, for the one file that runs
     * both arms in a single invocation. The producer's own fields stay on the process condition.
     */
    openCondition(condition: CampaignCondition): CampaignConditionHandle;
    /** Usage writes that threw. A paid response must never become a paid retry over a failed row. */
    readonly recordingFailures: () => number;
  };

/**
 * The one opening every F3 battery producer makes: the shared ledger's guard, the condition the
 * runner selected, and a durable usage recorder bound to the same file.
 *
 * The recorder is the half a spend reservation cannot stand in for. A hold is the most a dispatch
 * may cost, taken before it leaves and released or settled after; the matrix promises a per-case
 * response record with its real token usage, which only `recordApiCall` writes. Recording into
 * the campaign ledger rather than into an array the battery keeps means the record outlives the
 * process that bought it, which is what makes an interrupted campaign's spend legible afterwards.
 */
export function openCampaignProducer(options: CampaignProducerOptions): CampaignProducerHandle {
  const handle =
    options.campaignBudgetUsd === undefined
      ? openCampaignSpendingGuard(options.ceilingUsd)
      : openCampaignSpendingGuard(options.ceilingUsd, options.campaignBudgetUsd);
  let failures = 0;

  const openCondition = (condition: CampaignCondition): CampaignConditionHandle => {
    let caseKey = UNNAMED_CASE;
    return {
      condition,
      frameOverride: campaignFrameFor(condition),
      beginCase: (key: string) => {
        caseKey = key;
      },
      recordApiCall: (call: ApiCall) => {
        try {
          appendApiCall(handle.db, {
            ...call,
            surface: campaignUsageSurface(options.experiment, condition, caseKey, call.surface),
          });
        } catch {
          // Swallowed on purpose: the answer is already bought and already in the caller's hands.
          failures += 1;
        }
      },
    };
  };

  // The producer's own identity is the process condition, which is what a single-condition file
  // records under and what the runner's two invocations of a two-condition file select.
  const processContext = openCondition(campaignCondition());
  return {
    ...handle,
    ...processContext,
    experiment: options.experiment,
    openCondition,
    recordingFailures: () => failures,
  };
}
