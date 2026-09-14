import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULTS } from '../../config/defaults.js';
import { openSqliteHandle } from '../../sqlite/database.js';
import { GenerationCeilingReachedError } from '../errors.js';
import { ProviderRouter } from '../role-provider.js';
import {
  campaignFrameOverride,
  campaignLedgerPath,
  openCampaignProducer,
  openCampaignSpendingGuard,
} from './campaign-guard.js';

/**
 * The F3 rehearsal: proves the campaign's guarded request path with injected responses, and
 * proves the zero-budget control that nothing dispatches when the ceiling is already spent.
 * No live network call is made anywhere in this file; `fetchImpl` is a stub for every request.
 */

function textResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      usage: { input_tokens: 50, output_tokens: 5 },
    }),
    { status: 200 },
  );
}

function config() {
  return {
    ...DEFAULTS,
    anthropic: { ...DEFAULTS.anthropic, apiKey: 'sk-ant-test-campaign' },
  };
}

let dataDir: string | undefined;

afterEach(() => {
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

function ledgerFile(): string {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-f3-campaign-guard-'));
  return join(dataDir, 'campaign-ledger.sqlite');
}

describe('campaignLedgerPath', () => {
  it('reads AION_F3_CAMPAIGN_LEDGER when the campaign runner set one', () => {
    const path = ledgerFile();
    vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', path);
    try {
      expect(campaignLedgerPath()).toBe(path);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('falls back to a unique, file-backed path rather than :memory: when unset', () => {
    vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', '');
    try {
      const first = campaignLedgerPath();
      const second = campaignLedgerPath();
      expect(first).not.toBe(':memory:');
      expect(first).not.toBe(second);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('campaignFrameOverride', () => {
  it('selects the no-frame condition only on the literal value "none"', () => {
    vi.stubEnv('AION_F3_FRAME_OVERRIDE', 'none');
    try {
      expect(campaignFrameOverride()).toEqual({ none: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves the shipped condition (frameOverride undefined) unset or on any other value', () => {
    expect(campaignFrameOverride()).toBeUndefined();
    vi.stubEnv('AION_F3_FRAME_OVERRIDE', 'shipped');
    try {
      expect(campaignFrameOverride()).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('openCampaignSpendingGuard rehearsal', () => {
  it('reserves before dispatch and settles after, under an injected response', async () => {
    const path = ledgerFile();
    const handle = openCampaignSpendingGuard(DEFAULTS.anthropic.dailyCeilingUsd);
    try {
      const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"operation":"none"}')));
      const router = new ProviderRouter({
        config: config(),
        spending: handle.guard,
        fetchImpl,
      });

      await router.forRole('reflect').generate({
        surface: 'f3-rehearsal',
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'rehearsal only' }],
        schema: { type: 'object', properties: { operation: { type: 'string' } } },
        maxTokens: 64,
        think: false,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const today = handle.guard.today(new Date());
      expect(today.committedUsd).toBeGreaterThan(0);
    } finally {
      handle.close();
      void path;
    }
  });

  it('rehearses a sequence of dispatches on one shared ledger: the ceiling holds mid-campaign, not only at zero', async () => {
    const path = ledgerFile();
    // A known, fixed per-case bound (1,000 input + 100 output tokens on Haiku pricing) rather
    // than a figure learned from a live-shaped call: exact arithmetic here is the point, and the
    // pricing table's own unit test already covers whether that table itself is correct.
    const PER_CASE_BOUND: Parameters<
      ReturnType<typeof openCampaignSpendingGuard>['guard']['hold']
    >[0] = {
      surface: 'f3-rehearsal-case',
      model: 'claude-haiku-4-5',
      route: 'messages',
      inputTokens: 1_000,
      outputTokens: 100,
      now: new Date(),
    };
    const probeHandle = openCampaignSpendingGuard(DEFAULTS.anthropic.dailyCeilingUsd);
    const probed = probeHandle.guard.hold(PER_CASE_BOUND);
    if (!('hold' in probed)) {
      throw new Error('the probe reservation should not itself hit the shipped daily ceiling');
    }
    const perCaseUsd = probed.hold.reservedUsd;
    probed.hold.release();
    probeHandle.close();
    expect(perCaseUsd).toBeGreaterThan(0);

    // Room for exactly three of the matrix's cases, no more: the fourth must refuse before it
    // ever reaches the stubbed fetch, which is the guard doing its job mid-campaign rather than
    // only at a pre-exhausted ceiling.
    const handle = openCampaignSpendingGuard(perCaseUsd * 3.5);
    try {
      const holds: string[] = [];
      for (let caseIndex = 0; caseIndex < 3; caseIndex += 1) {
        const outcome = handle.guard.hold({
          ...PER_CASE_BOUND,
          surface: `case-${String(caseIndex)}`,
        });
        if (!('hold' in outcome)) {
          throw new Error(`case ${String(caseIndex)} should have fit inside 3.5 case-widths`);
        }
        holds.push(outcome.hold.reservationId);
        outcome.hold.settle(outcome.hold.reservedUsd);
      }
      expect(holds).toHaveLength(3);

      const fourth = handle.guard.hold({ ...PER_CASE_BOUND, surface: 'case-3' });
      expect('refused' in fourth).toBe(true);
      if ('refused' in fourth) {
        expect(fourth.refused).toBeInstanceOf(GenerationCeilingReachedError);
      }

      const committed = handle.guard.today(new Date()).committedUsd;
      expect(committed).toBeCloseTo(perCaseUsd * 3, 6);
      expect(committed).toBeLessThanOrEqual(perCaseUsd * 3.5);
    } finally {
      handle.close();
      void path;
    }
  });

  it('the zero-budget control: nothing dispatches when the ceiling is already spent', async () => {
    ledgerFile();
    const handle = openCampaignSpendingGuard(0);
    try {
      const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"operation":"none"}')));
      const router = new ProviderRouter({
        config: config(),
        spending: handle.guard,
        fetchImpl,
      });

      await expect(
        router.forRole('reflect').generate({
          surface: 'f3-zero-budget-control',
          model: 'claude-haiku-4-5',
          messages: [{ role: 'user', content: 'must never dispatch' }],
          schema: { type: 'object', properties: { operation: { type: 'string' } } },
          maxTokens: 64,
          think: false,
        }),
      ).rejects.toThrow(GenerationCeilingReachedError);

      // The proof that nothing escaped the guard: the stubbed fetch never ran at all.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(handle.guard.today(new Date()).committedUsd).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('the ledger survives a restart: reopening the same file keeps what was committed', async () => {
    const path = ledgerFile();
    const first = openCampaignSpendingGuard(DEFAULTS.anthropic.dailyCeilingUsd);
    const fetchImpl = vi.fn(() => Promise.resolve(textResponse('{"operation":"none"}')));
    try {
      const router = new ProviderRouter({
        config: config(),
        spending: first.guard,
        fetchImpl,
      });
      await router.forRole('reflect').generate({
        surface: 'f3-restart-probe',
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'first process' }],
        schema: { type: 'object', properties: { operation: { type: 'string' } } },
        maxTokens: 64,
        think: false,
      });
    } finally {
      // Simulates the process ending: the connection closes, the file on disk does not move.
      first.close();
    }

    const reopened = openSqliteHandle({ filePath: first.ledgerPath });
    try {
      const row = reopened.prepare('SELECT count(*) AS n FROM generation_spend').get() as {
        n: number;
      };
      expect(row.n).toBeGreaterThan(0);
    } finally {
      reopened.close();
      void path;
    }
  });

  it('the campaign-lifetime cap holds across a UTC rollover rather than refreshing with the day', () => {
    ledgerFile();
    // A generous daily ceiling and a campaign budget one small dispatch exhausts: the second
    // hold lands on the next UTC day, where the DAILY total has reset to zero, and only the
    // campaign-lifetime reading can still refuse it.
    const handle = openCampaignSpendingGuard(DEFAULTS.anthropic.dailyCeilingUsd, 0.005);
    try {
      const request = {
        surface: 'f3-rollover-probe',
        model: 'claude-haiku-4-5',
        route: 'messages',
        inputTokens: 2_000,
        outputTokens: 500,
      } as const;

      const yesterday = handle.guard.hold({ ...request, now: new Date('2026-09-13T23:59:00Z') });
      expect('hold' in yesterday).toBe(true);
      if ('hold' in yesterday) {
        yesterday.hold.settle(0.004, new Date('2026-09-13T23:59:30Z'));
      }

      const afterMidnight = new Date('2026-09-14T00:01:00Z');
      expect(handle.guard.today(afterMidnight).committedUsd).toBe(0);
      const secondDay = handle.guard.hold({ ...request, now: afterMidnight });
      expect('refused' in secondDay).toBe(true);
      if ('refused' in secondDay) {
        expect(secondDay.refused).toBeInstanceOf(GenerationCeilingReachedError);
      }
      // The refused hold released itself, so the fresh day's ledger still reads clean.
      expect(handle.guard.today(afterMidnight).committedUsd).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('leaves the daily-only shape untouched when no campaign budget is named', () => {
    ledgerFile();
    const handle = openCampaignSpendingGuard(DEFAULTS.anthropic.dailyCeilingUsd);
    try {
      const outcome = handle.guard.hold({
        surface: 'f3-daily-only-probe',
        model: 'claude-haiku-4-5',
        route: 'messages',
        inputTokens: 2_000,
        outputTokens: 500,
        now: new Date('2026-09-14T00:01:00Z'),
      });
      expect('hold' in outcome).toBe(true);
      if ('hold' in outcome) {
        outcome.hold.release(new Date('2026-09-14T00:02:00Z'));
      }
    } finally {
      handle.close();
    }
  });
});

describe('openCampaignProducer', () => {
  const request = {
    surface: 'tier3_advisor',
    model: 'claude-haiku-4-5',
    route: 'messages' as const,
    inputTokens: 1_000,
    outputTokens: 100,
  };

  /**
   * The composition the campaign actually runs: a coordinator declares the lifetime budget on
   * the shared ledger, and each battery file opens its own producer against that same file with
   * the daily ceiling alone. The budget has to reach those producers, or the cap governs one
   * handle in a parent process and nothing that spends.
   */
  it('binds a battery producer to the budget the coordinator declared on the shared ledger', () => {
    const path = ledgerFile();
    vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', path);
    try {
      const coordinator = openCampaignSpendingGuard(DEFAULTS.anthropic.dailyCeilingUsd, 0);
      const battery = openCampaignProducer({
        experiment: 'advisor',
        ceilingUsd: DEFAULTS.anthropic.dailyCeilingUsd,
      });
      try {
        expect(battery.campaignBudgetUsd).toBe(0);
        const outcome = battery.guard.hold({ ...request, now: new Date() });
        expect('refused' in outcome).toBe(true);
        if ('refused' in outcome) {
          expect(outcome.refused).toBeInstanceOf(GenerationCeilingReachedError);
        }
      } finally {
        battery.close();
        coordinator.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * The record a reservation is not. The guard bounds what a case may cost; this is what the
   * response did cost, under the case that bought it, on a file that outlives the process.
   */
  it('records each response durably under its own experiment, condition and case', () => {
    const path = ledgerFile();
    vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', path);
    try {
      const producer = openCampaignProducer({
        experiment: 'advisor',
        ceilingUsd: DEFAULTS.anthropic.dailyCeilingUsd,
      });
      try {
        for (const caseKey of ['queue-depth', 'orphan-share']) {
          producer.beginCase(caseKey);
          producer.recordApiCall({
            occurredAt: new Date('2026-09-13T12:00:00Z'),
            model: 'claude-haiku-4-5',
            surface: 'tier3_advisor',
            inputTokens: 1_000,
            outputTokens: 100,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            durationMs: 1_200,
            attempts: 1,
          });
        }
        expect(producer.recordingFailures()).toBe(0);
      } finally {
        producer.close();
      }

      // Reopened as a separate connection, which is the point: the record is on the file.
      const reopened = openSqliteHandle({ filePath: path });
      try {
        const rows = reopened
          .prepare(
            'SELECT surface, input_tokens AS inputTokens, attempts FROM api_calls ORDER BY id',
          )
          .all() as { surface: string; inputTokens: number; attempts: number }[];
        expect(rows.map((row) => row.surface)).toEqual([
          'f3/advisor/shipped-frame/queue-depth/tier3_advisor',
          'f3/advisor/shipped-frame/orphan-share/tier3_advisor',
        ]);
        expect(rows.every((row) => row.inputTokens === 1_000 && row.attempts === 1)).toBe(true);
      } finally {
        reopened.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * The seam the extraction root runs both arms through. The process condition is shipped-frame
   * here, and the no-frame arm still records as no-frame, because the frame it sends and the
   * condition it names are one field. Before this, a file running both arms inside one process
   * took the frame from the arm and the label from the environment.
   */
  it('records a self-named arm under the frame that arm sends, not the process condition', () => {
    const path = ledgerFile();
    vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', path);
    vi.stubEnv('AION_F3_FRAME_OVERRIDE', 'shipped');
    try {
      const producer = openCampaignProducer({
        experiment: 'extraction-faithfulness',
        ceilingUsd: DEFAULTS.anthropic.dailyCeilingUsd,
      });
      try {
        expect(producer.condition).toBe('shipped-frame');
        for (const condition of ['no-frame', 'shipped-frame'] as const) {
          const arm = producer.openCondition(condition);
          expect(arm.frameOverride).toEqual(condition === 'no-frame' ? { none: true } : undefined);
          arm.beginCase('fixture-1/entities');
          arm.recordApiCall({
            occurredAt: new Date('2026-09-13T12:00:00Z'),
            model: 'claude-haiku-4-5',
            surface: 'unlabeled',
            inputTokens: 30,
            outputTokens: 5,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            durationMs: 1,
            attempts: 1,
          });
        }
        const rows = producer.db.prepare('SELECT surface FROM api_calls ORDER BY id').all() as {
          surface: string;
        }[];
        expect(rows.map((row) => row.surface)).toEqual([
          'f3/extraction-faithfulness/no-frame/fixture-1/entities/unlabeled',
          'f3/extraction-faithfulness/shipped-frame/fixture-1/entities/unlabeled',
        ]);
        expect(producer.recordingFailures()).toBe(0);
      } finally {
        producer.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /** Each arm carries its own case name: naming one must not rename rows the other buys. */
  it('keeps each arm’s case name to itself', () => {
    const path = ledgerFile();
    vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', path);
    try {
      const producer = openCampaignProducer({
        experiment: 'extraction-faithfulness',
        ceilingUsd: 5,
      });
      try {
        const call = {
          occurredAt: new Date('2026-09-13T12:00:00Z'),
          model: 'claude-haiku-4-5',
          surface: 'unlabeled',
          inputTokens: 30,
          outputTokens: 5,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          durationMs: 1,
          attempts: 1,
        };
        const first = producer.openCondition('no-frame');
        const second = producer.openCondition('shipped-frame');
        first.beginCase('fixture-1/entities');
        second.beginCase('fixture-9/cognitive');
        first.recordApiCall(call);
        second.recordApiCall(call);
        const rows = producer.db.prepare('SELECT surface FROM api_calls ORDER BY id').all() as {
          surface: string;
        }[];
        expect(rows.map((row) => row.surface)).toEqual([
          'f3/extraction-faithfulness/no-frame/fixture-1/entities/unlabeled',
          'f3/extraction-faithfulness/shipped-frame/fixture-9/cognitive/unlabeled',
        ]);
      } finally {
        producer.close();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
