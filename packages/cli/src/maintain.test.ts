import { describe, expect, it } from 'vitest';

import { parseMaintainFlags, runMaintain } from './maintain.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseMaintainFlags', () => {
  it('defaults to listing the catalog', () => {
    expect(parseMaintainFlags([])).toEqual({ subcommand: 'ls' });
  });

  it('takes the operation name for a forced run', () => {
    expect(parseMaintainFlags(['run', 'redaction_residue_purge'])).toEqual({
      subcommand: 'run',
      operation: 'redaction_residue_purge',
    });
  });

  it('refuses a run with no operation named', () => {
    expect(() => parseMaintainFlags(['run'])).toThrow('maintain run needs an operation name');
  });

  it('refuses a subcommand it does not have', () => {
    expect(() => parseMaintainFlags(['force'])).toThrow(
      "unknown maintain subcommand 'force' (supported: ls, run)",
    );
  });
});

describe('aion maintain ls', () => {
  it('names every registered operation and which condition it answers', async () => {
    const out = collector();
    expect(await runMaintain(['ls'], out.write)).toBe(0);

    const listing = out.lines.join('\n');
    // The escape hatch exists for this one: a leak is an incident to a person and a small
    // share to a scoring function.
    expect(listing).toContain('redaction_residue_purge');
    expect(listing).toContain(
      'emergency_relationship_repair  quarter-hour window, critical responder for missing_backbone_links',
    );
    expect(listing).toContain(
      'orphan_cleanup  quarter-hour window, critical responder for orphan_share',
    );
    expect(listing).toContain(
      'vector_backfill  quarter-hour window, critical responder for vector_parity',
    );
    expect(listing).toContain('community_refresh  day window, routine');
    expect(listing).toContain('proposal_hygiene  day window, routine');
    // merge_shadow judged what merge_auto would do without ever acting on it; merge_auto
    // itself already acts, so the shadow judge is retired rather than a selectable lane.
    expect(listing).not.toContain('merge_shadow');
  });
});
