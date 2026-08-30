import { describe, expect, it } from 'vitest';

import { CliUsageError, parseArgs, unknownOption, wantsHelp, type ArgSpec } from './args.js';

const WITH_SUBCOMMANDS: ArgSpec<'ls' | 'apply'> = {
  command: 'demo',
  usage: 'aion demo [ls | apply] <id> [--all] [--limit <n>]',
  subcommands: ['ls', 'apply'],
  options: [{ flag: '--all' }, { flag: '--limit', takesValue: true }],
  maxPositionals: 1,
};

const BARE: ArgSpec = {
  command: 'bare',
  usage: 'aion bare',
};

describe('parseArgs', () => {
  it('defaults to the first subcommand and reads flags, values, and one positional', () => {
    expect(parseArgs(WITH_SUBCOMMANDS, [])).toEqual({
      subcommand: 'ls',
      flags: new Set(),
      values: new Map(),
      positionals: [],
    });

    const parsed = parseArgs(WITH_SUBCOMMANDS, ['apply', 'id-1', '--all', '--limit', '5']);
    expect(parsed.subcommand).toBe('apply');
    expect(parsed.flags.has('--all')).toBe(true);
    expect(parsed.values.get('--limit')).toBe('5');
    expect(parsed.positionals).toEqual(['id-1']);
  });

  it('reads an alias as its long spelling', () => {
    const spec: ArgSpec = {
      command: 'demo',
      usage: 'aion demo [--yes]',
      options: [{ flag: '--yes', alias: '-y' }],
    };

    expect(parseArgs(spec, ['-y']).flags.has('--yes')).toBe(true);
  });

  it('names the supported set on an unknown subcommand, option, or missing value', () => {
    expect(() => parseArgs(WITH_SUBCOMMANDS, ['purge'])).toThrow(
      "unknown demo subcommand 'purge' (supported: ls, apply)",
    );
    expect(() => parseArgs(WITH_SUBCOMMANDS, ['ls', '--nope'])).toThrow(
      "unknown option '--nope' for demo (supported: --all, --limit)",
    );
    expect(() => parseArgs(WITH_SUBCOMMANDS, ['ls', '--limit'])).toThrow('--limit needs a value');
  });

  /**
   * A command that takes no bare arguments reads a stray word as a mistyped option, which is
   * what it almost always is; one that does take them names the argument it could not place.
   */
  it('rejects a bare argument past the cap in the words the command can act on', () => {
    expect(() => parseArgs(WITH_SUBCOMMANDS, ['ls', 'id-1', 'id-2'])).toThrow(
      "unexpected extra argument 'id-2' for demo (usage: aion demo [ls | apply] <id> [--all] [--limit <n>])",
    );
    expect(() => parseArgs(BARE, ['stray'])).toThrow("unknown option 'stray' for bare");
  });

  it('raises one class, so nothing downstream reads an error name back', () => {
    expect(() => parseArgs(BARE, ['stray'])).toThrow(CliUsageError);
    expect(unknownOption(BARE, '--x')).toBeInstanceOf(CliUsageError);
  });
});

describe('wantsHelp', () => {
  it('answers to both spellings and to nothing else', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['ls', '-h'])).toBe(true);
    expect(wantsHelp(['ls', '--all'])).toBe(false);
  });
});
