import {
  getSupersessionProposal,
  recordEntityMergeProposal,
  recordSupersessionProposal,
  SqliteStore,
} from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConflictingApplyScopeError,
  MissingProposalIdError,
  parseProposalFlags,
  runProposals,
  UnknownProposalOptionError,
  UnknownProposalSubcommandError,
} from './proposals.js';

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

describe('parseProposalFlags', () => {
  it('defaults to listing the open rows', () => {
    expect(parseProposalFlags([])).toEqual({ subcommand: 'ls', all: false, scope: 'family' });
  });

  /**
   * The default widened after a claim-level apply measured no change in what recall answered,
   * so an apply with no flag now closes the siblings naming the same subject. Both escapes
   * stay reachable in one keystroke, and neither is the thing a hurried operator gets by
   * accident.
   */
  it('applies the subject family unless a flag narrows or widens it', () => {
    expect(parseProposalFlags(['apply', 'p-1'])).toEqual({
      subcommand: 'apply',
      id: 'p-1',
      all: false,
      scope: 'family',
    });
    expect(parseProposalFlags(['apply', 'p-1', '--claim-only'])).toEqual({
      subcommand: 'apply',
      id: 'p-1',
      all: false,
      scope: 'claim',
    });
    expect(parseProposalFlags(['apply', 'p-1', '--episode'])).toEqual({
      subcommand: 'apply',
      id: 'p-1',
      all: false,
      scope: 'episode',
    });
  });

  it('refuses an unknown subcommand, an unknown option, or an apply with no id', () => {
    expect(() => parseProposalFlags(['approve'])).toThrow(UnknownProposalSubcommandError);
    expect(() => parseProposalFlags(['ls', '--everything'])).toThrow(UnknownProposalOptionError);
    expect(() => parseProposalFlags(['apply'])).toThrow(MissingProposalIdError);
    expect(() => parseProposalFlags(['dismiss'])).toThrow(MissingProposalIdError);
  });

  // Two scopes at once has no safe reading: one is narrower than the default and the other is
  // wider, so guessing which the operator meant would close either too little or far too much.
  it('refuses to guess between the narrow escape and the wide one', () => {
    expect(() => parseProposalFlags(['apply', 'p-1', '--claim-only', '--episode'])).toThrow(
      ConflictingApplyScopeError,
    );
  });
});

describe('aion proposals against a seeded review queue', () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cli-proposals-'));
    process.env.AION_SQLITE_PATH = join(dir, 'aion.sqlite');
    process.env.AION_LOG_FILE = join(dir, 'aion.jsonl');
    process.env.AION_LOG_LEVEL = 'fatal';
    store = new SqliteStore({ filePath: join(dir, 'aion.sqlite') });
  });

  afterEach(() => {
    store.close();
    delete process.env.AION_SQLITE_PATH;
    delete process.env.AION_LOG_FILE;
    delete process.env.AION_LOG_LEVEL;
    rmSync(dir, { recursive: true, force: true });
  });

  function seedSupersession(): string {
    return recordSupersessionProposal(store.db, {
      oldId: 'old-claim',
      newId: 'new-claim',
      confidence: 1,
      rationale: 'fanout transport',
      episodeId: 'episode-2',
    });
  }

  /**
   * The table had never held a row, which broke reading the queue without raw SQL inside
   * the container. The first live proposal row had to be found before the queue could be
   * queried programmatically.
   */
  it('lists both review queues, with what each proposal would do', async () => {
    const id = seedSupersession();
    recordEntityMergeProposal(store.db, {
      subject: { id: 'ent-a', name: 'gitlab-token', type: 'credential' },
      candidate: { id: 'ent-b', name: 'github-token', type: 'credential' },
      similarity: 0.91,
      episodeId: 'episode-3',
    });
    const { lines, write } = collector();

    expect(await runProposals(['ls'], write)).toBe(0);

    const output = lines.join('\n');
    expect(output).toContain(id);
    expect(output).toContain('would close old-clai');
    expect(output).toContain('fanout transport');
    expect(output).toContain('gitlab-token');
    expect(output).toContain('github-token');
    expect(output).toContain('supersession proposals (1)');
    expect(output).toContain('entity-merge proposals (1)');
  });

  it('says so plainly when there is nothing to review', async () => {
    const { lines, write } = collector();

    expect(await runProposals(['ls'], write)).toBe(0);

    expect(lines.join('\n')).toContain('none');
  });

  it('dismisses a judgment without touching the graph, and drops it from the queue', async () => {
    const id = seedSupersession();
    const { lines, write } = collector();

    expect(await runProposals(['dismiss', id], write)).toBe(0);

    expect(lines.join('\n')).toContain('stands');
    expect(getSupersessionProposal(store.db, id)?.resolvedAt).toEqual(expect.any(String));

    const listed = collector();
    await runProposals(['ls'], listed.write);
    expect(listed.lines.join('\n')).toContain('supersession proposals (0)');

    const all = collector();
    await runProposals(['ls', '--all'], all.write);
    expect(all.lines.join('\n')).toContain(id);
  });

  it('refuses a second decision on a proposal someone already decided', async () => {
    const id = seedSupersession();
    await runProposals(['dismiss', id], () => undefined);

    expect(await runProposals(['dismiss', id], () => undefined)).toBe(1);
  });

  it('refuses an id nobody proposed rather than reporting a no-op as done', async () => {
    expect(await runProposals(['dismiss', 'not-a-proposal'], () => undefined)).toBe(1);
  });
});
