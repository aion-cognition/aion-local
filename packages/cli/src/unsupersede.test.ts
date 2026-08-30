import { describe, expect, it } from 'vitest';

import { CliUsageError } from './args.js';
import { parseUnsupersedeFlags, renderPreview } from './unsupersede.js';

const NODE_ID = '2b407722-750c-85ad-1d92-65e5a038ff1d';

describe('unsupersede flags', () => {
  it('takes one node id', () => {
    expect(parseUnsupersedeFlags([NODE_ID])).toEqual({ nodeId: NODE_ID, yes: false });
  });

  it('reads --yes in either position', () => {
    expect(parseUnsupersedeFlags([NODE_ID, '--yes']).yes).toBe(true);
    expect(parseUnsupersedeFlags(['--yes', NODE_ID]).yes).toBe(true);
  });

  it('refuses an invocation with no id', () => {
    expect(() => parseUnsupersedeFlags([])).toThrow(CliUsageError);
  });

  it('refuses a second id rather than guessing which one is meant', () => {
    expect(() => parseUnsupersedeFlags([NODE_ID, 'another'])).toThrow(CliUsageError);
  });

  it('refuses an unknown flag', () => {
    expect(() => parseUnsupersedeFlags([NODE_ID, '--force'])).toThrow(CliUsageError);
  });
});

describe('the preview a reopen shows first', () => {
  it('names what closed the claim, so the operator sees whether a person or the judge did it', () => {
    const lines: string[] = [];
    renderPreview(
      {
        id: NODE_ID,
        labels: ['Decision', 'Memory'],
        content: 'Bramble session state is stored in Redis.',
        closed: true,
        forgotten: false,
        lineage: [
          { supersededBy: 'new-1', provenance: ['supersession_unanimous_auto'] },
          { supersededBy: 'new-2', provenance: [] },
        ],
      },
      (line) => lines.push(line),
    );

    expect(lines[0]).toContain('about to reopen');
    expect(lines[0]).toContain('Bramble session state is stored in Redis.');
    expect(lines[1]).toBe('  superseded by new-1, closed by supersession_unanimous_auto');
    expect(lines[2]).toBe('  superseded by new-2, closed by unrecorded');
  });

  /** Two suppressions, one act each: a reopen that also un-forgot would be doing two things. */
  it('says a forgotten node stays forgotten', () => {
    const lines: string[] = [];
    renderPreview(
      {
        id: NODE_ID,
        labels: ['Concept'],
        content: 'a claim',
        closed: true,
        forgotten: true,
        lineage: [],
      },
      (line) => lines.push(line),
    );

    expect(lines.join('\n')).toContain('does not undo that');
  });
});
