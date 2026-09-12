import { describe, expect, it } from 'vitest';

import { reportSuppression, type SuppressionReport } from './suppression.js';
import { parseUnforgetFlags } from './unforget.js';

const logger = { warn: () => undefined, info: () => undefined } as never;

function lines(): { readonly write: (line: string) => void; readonly said: string[] } {
  const said: string[] = [];
  return { write: (line: string) => said.push(line), said };
}

describe('parseUnforgetFlags', () => {
  it('reads a node id and --yes in either position', () => {
    expect(parseUnforgetFlags(['node-1'])).toEqual({ nodeId: 'node-1', yes: false });
    expect(parseUnforgetFlags(['--yes', 'node-1'])).toEqual({ nodeId: 'node-1', yes: true });
  });

  it('rejects a missing id, a second positional and an unknown option', () => {
    expect(() => parseUnforgetFlags([])).toThrow('unforget needs a node id');
    expect(() => parseUnforgetFlags(['a', 'b'])).toThrow();
    expect(() => parseUnforgetFlags(['--bogus', 'node-1'])).toThrow("unknown option '--bogus'");
  });
});

describe('reportSuppression', () => {
  const acknowledged: SuppressionReport = {
    code: 0,
    outcome: {
      status: 'acknowledged',
      operationId: 'op-1',
      sequence: '1',
      result: { changed: true },
      knownFrom: '2026-09-12T09:00:00.000Z',
      observedAckAt: '2026-09-12T09:00:00.000Z',
      clockClamped: false,
    },
  };

  function refused(reason: string): SuppressionReport {
    return {
      code: 1,
      outcome: { status: 'deferred', operationId: 'op-1', sequence: '1', reason },
    };
  }

  it('says what landed and when, for each act', () => {
    const forget = lines();
    expect(reportSuppression('forget', 'node-1', acknowledged, logger, forget.write)).toBe(0);
    expect(forget.said[0]).toBe('forgot node-1 at 2026-09-12T09:00:00.000Z');

    const unforget = lines();
    expect(reportSuppression('unforget', 'node-1', acknowledged, logger, unforget.write)).toBe(0);
    expect(unforget.said[0]).toBe('unforgot node-1 at 2026-09-12T09:00:00.000Z');
  });

  it('answers a no-op refusal as the state the caller asked for, not as a failure', () => {
    for (const reason of ['already_forgotten', 'not_forgotten']) {
      const out = lines();
      expect(reportSuppression('forget', 'node-1', refused(reason), logger, out.write)).toBe(0);
      expect(out.said).toHaveLength(1);
    }
  });

  it('fails on a missing node and on a refusal it has no words for', () => {
    const missing = lines();
    expect(
      reportSuppression('forget', 'node-1', refused('node_absent'), logger, missing.write),
    ).toBe(1);
    const unknown = lines();
    expect(
      reportSuppression(
        'forget',
        'node-1',
        refused('coverage_epoch_changed'),
        logger,
        unknown.write,
      ),
    ).toBe(1);
  });
});
