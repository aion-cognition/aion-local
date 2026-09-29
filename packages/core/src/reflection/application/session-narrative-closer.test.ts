import { describe, expect, it, vi } from 'vitest';

import { NARRATIVE_SESSION_MISSING } from './family-selection.js';
import { closeSessionNarrative, type NarrativeDeps, type NarrativeResult } from './narratives.js';
import { SessionNarrativeCloser } from './session-narrative-closer.js';

vi.mock('./narratives.js', () => ({ closeSessionNarrative: vi.fn() }));

function closerWith(result: NarrativeResult): {
  readonly closer: SessionNarrativeCloser;
  readonly debug: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
} {
  vi.mocked(closeSessionNarrative).mockResolvedValue(result);
  const debug = vi.fn();
  const warn = vi.fn();
  const logger = { debug, warn, info: vi.fn(), error: vi.fn() };
  const deps = { logger } as unknown as NarrativeDeps;
  return { closer: new SessionNarrativeCloser(deps), debug, warn };
}

describe('the session close narrative log', () => {
  it('logs a session that never created a Session node at debug', async () => {
    const { closer, debug, warn } = closerWith({
      status: 'failed',
      sessionId: 's1',
      episodes: 0,
      summary: NARRATIVE_SESSION_MISSING,
    });

    closer.onSessionClosed('s1');
    await closer.whenIdle();

    expect(debug).toHaveBeenCalledWith(
      { sessionId: 's1', summary: NARRATIVE_SESSION_MISSING },
      'session close narrative did not write',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps any other refusal a warning', async () => {
    const { closer, debug, warn } = closerWith({
      status: 'failed',
      sessionId: 's2',
      episodes: 0,
      summary: 'coverage coverage_contract_not_active',
    });

    closer.onSessionClosed('s2');
    await closer.whenIdle();

    expect(warn).toHaveBeenCalledWith(
      { sessionId: 's2', summary: 'coverage coverage_contract_not_active' },
      'session close narrative did not write',
    );
    expect(debug).not.toHaveBeenCalled();
  });
});
