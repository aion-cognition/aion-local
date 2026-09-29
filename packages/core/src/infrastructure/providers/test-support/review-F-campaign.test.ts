import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCampaignSpendingGuard, campaignCommittedUsd } from './campaign-guard.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-F-review-budget-'));
  vi.stubEnv('TEST_AION_CAMPAIGN_LEDGER', join(dir, 'shared.sqlite'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const request = {
  surface: 'review',
  model: 'claude-haiku-4-5',
  route: 'messages' as const,
  inputTokens: 1000,
  outputTokens: 0,
};
it('makes the matrix budget bind the one-argument guard a battery file opens', () => {
  const owner = openCampaignSpendingGuard(5, 0);
  const battery = openCampaignSpendingGuard(5);
  try {
    const result = battery.guard.hold({ ...request, now: new Date('2026-09-13T12:00:00Z') });
    console.log(
      JSON.stringify({
        case: 'battery-ignores-owner-cap',
        allowed: 'hold' in result,
        committed: campaignCommittedUsd(battery.db),
      }),
    );
    expect('refused' in result).toBe(true);
  } finally {
    battery.close();
    owner.close();
  }
});
it('keeps the lifetime cap through a battery-file reopen after midnight', () => {
  const owner = openCampaignSpendingGuard(5, 0.0015);
  const first = owner.guard.hold({ ...request, now: new Date('2026-09-13T23:59:00Z') });
  expect('hold' in first).toBe(true);
  if ('hold' in first) {
    first.hold.settle(first.hold.reservedUsd);
  }
  owner.close();
  const battery = openCampaignSpendingGuard(5);
  try {
    const result = battery.guard.hold({ ...request, now: new Date('2026-09-14T00:01:00Z') });
    console.log(
      JSON.stringify({
        case: 'battery-rollover',
        allowed: 'hold' in result,
        committed: campaignCommittedUsd(battery.db),
      }),
    );
    expect('refused' in result).toBe(true);
  } finally {
    battery.close();
  }
});
it('still refuses the directly configured zero daily budget', () => {
  const battery = openCampaignSpendingGuard(0);
  try {
    expect('refused' in battery.guard.hold({ ...request, now: new Date() })).toBe(true);
  } finally {
    battery.close();
  }
});
