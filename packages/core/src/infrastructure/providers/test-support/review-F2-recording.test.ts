import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openCampaignProducer } from './campaign-guard.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-Ffix1-record-'));
  vi.stubEnv('AION_F3_CAMPAIGN_LEDGER', join(dir, 'campaign.sqlite'));
  vi.stubEnv('AION_F3_FRAME_OVERRIDE', 'shipped');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
const call = {
  occurredAt: new Date('2026-09-13T12:00:00Z'),
  model: 'claude-haiku-4-5',
  surface: 'entities',
  inputTokens: 30,
  outputTokens: 5,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  durationMs: 1,
  attempts: 1,
};
it('records the condition actually dispatched by the new two-arm extraction root', () => {
  const producer = openCampaignProducer({ experiment: 'extraction-faithfulness', ceilingUsd: 5 });
  try {
    // The live root's arrangement, through the seam it actually invokes (`openCondition`, called
    // once per arm by `extraction-experiment.ts`): the frame the client is handed and the
    // condition the row names come off one context. The process condition here is shipped-frame,
    // which is what the earlier arrangement recorded. No request is sent by this test.
    const arm = producer.openCondition('no-frame');
    expect(arm.frameOverride).toEqual({ none: true });
    expect(producer.condition).toBe('shipped-frame');
    arm.beginCase('fixture-1/entities');
    arm.recordApiCall(call);
    const rows = producer.db.prepare('SELECT surface FROM api_calls').all() as {
      surface: string;
    }[];
    console.log(
      JSON.stringify({
        case: 'extraction-condition-label',
        actualFrame: { name: arm.condition, frame: arm.frameOverride },
        rows,
      }),
    );
    expect(rows[0]?.surface.startsWith('f3/extraction-faithfulness/no-frame/')).toBe(true);
  } finally {
    producer.close();
  }
});
it('keeps ordinary single-condition producer labels correct', () => {
  const producer = openCampaignProducer({ experiment: 'advisor', ceilingUsd: 5 });
  try {
    producer.beginCase('case-1');
    producer.recordApiCall(call);
    const row = producer.db.prepare('SELECT surface FROM api_calls').get() as { surface: string };
    expect(row.surface).toBe('f3/advisor/shipped-frame/case-1/entities');
  } finally {
    producer.close();
  }
});
