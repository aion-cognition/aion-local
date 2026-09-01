import { describe, expect, it } from 'vitest';

import { coOccursLedgerKey } from './associations.js';
import { stageLedgerKey } from './stage.js';
import { PIPELINE_VERSION } from './version.js';
import { orchestratorLedgerKey } from '../application/orchestrator.js';
import { coExtractionLedgerKey } from '../application/stages/reinforcement.js';

/**
 * The version is a ledger key segment, so it has to survive being spliced into one: a value
 * carrying the separator would split a key into a different shape than the builder wrote.
 */
describe('PIPELINE_VERSION', () => {
  it('is a single key segment', () => {
    expect(PIPELINE_VERSION).not.toBe('');
    expect(PIPELINE_VERSION).not.toContain(':');
  });
});

describe('the version segment every reflection key carries', () => {
  it('sits between the family and the episode, so one family prefix reads one version', () => {
    expect(orchestratorLedgerKey('v9', 'episode-1')).toBe('reflection:orchestrator:v9:episode-1');
    expect(stageLedgerKey('v9', 'cognitive', 'episode-1')).toBe(
      'reflection:stage:v9:cognitive:episode-1',
    );
    expect(coOccursLedgerKey('v9', 'episode-1')).toBe('association.co_occurs:v9:episode-1');
    expect(coExtractionLedgerKey('v9', 'episode-1')).toBe(
      'reinforcement.co_extraction:v9:episode-1',
    );
  });

  it('forks the key space, so two versions of one episode never share a gate', () => {
    const keys = [
      orchestratorLedgerKey('v1', 'episode-1'),
      orchestratorLedgerKey('v2', 'episode-1'),
      stageLedgerKey('v1', 'cognitive', 'episode-1'),
      stageLedgerKey('v2', 'cognitive', 'episode-1'),
      coOccursLedgerKey('v1', 'episode-1'),
      coOccursLedgerKey('v2', 'episode-1'),
      coExtractionLedgerKey('v1', 'episode-1'),
      coExtractionLedgerKey('v2', 'episode-1'),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
