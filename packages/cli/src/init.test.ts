import { describe, expect, it } from 'vitest';

import {
  parseInitFlags,
  resolveAnthropicKey,
  resolveInitProfile,
  resolveMemberName,
} from './init.js';
import { registrationCommand, registrationJson } from './registration.js';

const never = async (): Promise<string> => {
  throw new Error('prompt must not run');
};

describe('parseInitFlags', () => {
  it('defaults to interactive confirmation', () => {
    expect(parseInitFlags([])).toEqual({ assumeYes: false });
  });

  it('accepts --yes and -y', () => {
    expect(parseInitFlags(['--yes']).assumeYes).toBe(true);
    expect(parseInitFlags(['-y']).assumeYes).toBe(true);
  });

  it('rejects an unknown option', () => {
    expect(() => parseInitFlags(['--force'])).toThrow(
      /unknown option .* for init \(supported: local, full, --install, --yes\)/,
    );
  });

  it('accepts either profile as a bare word and leaves it unset otherwise', () => {
    expect(parseInitFlags(['local']).profile).toBe('local');
    expect(parseInitFlags(['full', '--yes'])).toEqual({ assumeYes: true, profile: 'full' });
    expect(parseInitFlags([]).profile).toBeUndefined();
  });

  it('rejects a word that is neither profile', () => {
    expect(() => parseInitFlags(['medium'])).toThrow(
      /unknown option .* for init \(supported: local, full, --install, --yes\)/,
    );
  });

  it('takes the install profile as a flag, and leaves it unset to follow config', () => {
    expect(parseInitFlags(['--install', 'native']).install).toBe('native');
    expect(parseInitFlags(['full', '--install', 'docker', '--yes'])).toEqual({
      assumeYes: true,
      profile: 'full',
      install: 'docker',
    });
    expect(parseInitFlags([]).install).toBeUndefined();
  });

  it('still takes the old --profile spelling, and does not advertise it', () => {
    // One release called it `--profile`, which put two different questions under one word in the
    // same usage line. The alias keeps that invocation working; the usage names `--install`.
    expect(parseInitFlags(['--profile', 'native']).install).toBe('native');
    expect(() => parseInitFlags(['--nope'])).toThrow(/supported: local, full, --install, --yes/);
  });

  it('refuses an install profile it does not have, rather than defaulting quietly', () => {
    // The flag decides whether init drives compose or a host machine. A typo that fell through to
    // the default would bring up the other substrate. The refusal names the spelling that was
    // actually typed, so the alias does not answer about a flag nobody used.
    expect(() => parseInitFlags(['--install', 'podman'])).toThrow(
      "--install takes docker or native, not 'podman'",
    );
    expect(() => parseInitFlags(['--profile', 'podman'])).toThrow(
      "--profile takes docker or native, not 'podman'",
    );
    expect(() => parseInitFlags(['--install'])).toThrow('--install needs a value');
  });
});

describe('resolveInitProfile', () => {
  it('takes the profile the command line named', async () => {
    await expect(
      resolveInitProfile({ requested: 'full', assumeYes: false, interactive: true, ask: never }),
    ).resolves.toBe('full');
  });

  it('defaults to local under --yes and with no terminal', async () => {
    await expect(
      resolveInitProfile({ requested: undefined, assumeYes: true, interactive: true, ask: never }),
    ).resolves.toBe('local');
    await expect(
      resolveInitProfile({
        requested: undefined,
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('local');
  });

  it('asks on a terminal and keeps local for anything but full', async () => {
    await expect(
      resolveInitProfile({
        requested: undefined,
        assumeYes: false,
        interactive: true,
        ask: async () => 'FULL',
      }),
    ).resolves.toBe('full');
    await expect(
      resolveInitProfile({
        requested: undefined,
        assumeYes: false,
        interactive: true,
        ask: async () => '',
      }),
    ).resolves.toBe('local');
  });
});

describe('resolveAnthropicKey', () => {
  it('prefers the configured key, then the one already in .env', async () => {
    await expect(
      resolveAnthropicKey({
        configured: 'sk-configured',
        fromEnvFile: 'sk-file',
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('sk-configured');
    await expect(
      resolveAnthropicKey({
        configured: '',
        fromEnvFile: 'sk-file',
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('sk-file');
  });

  it('asks for a missing key on a terminal', async () => {
    await expect(
      resolveAnthropicKey({
        configured: '',
        fromEnvFile: undefined,
        assumeYes: false,
        interactive: true,
        ask: async () => '  sk-typed ',
      }),
    ).resolves.toBe('sk-typed');
  });

  it('fails by name under --yes and with no terminal to ask on', async () => {
    await expect(
      resolveAnthropicKey({
        configured: '',
        fromEnvFile: undefined,
        assumeYes: true,
        interactive: true,
        ask: never,
      }),
    ).rejects.toThrow(/needs AION_ANTHROPIC_API_KEY/);
    await expect(
      resolveAnthropicKey({
        configured: '',
        fromEnvFile: undefined,
        assumeYes: false,
        interactive: true,
        ask: async () => '',
      }),
    ).rejects.toThrow(/needs AION_ANTHROPIC_API_KEY/);
  });
});

describe('resolveMemberName', () => {
  it('takes the git name as-is without a terminal', async () => {
    await expect(
      resolveMemberName({
        envName: 'Ryan Huber',
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('Ryan Huber');
  });

  it('takes the git name as-is under --yes even on a terminal', async () => {
    await expect(
      resolveMemberName({ envName: 'Ryan Huber', assumeYes: true, interactive: true, ask: never }),
    ).resolves.toBe('Ryan Huber');
  });

  it('offers the git name as the prompt default and keeps it on an empty answer', async () => {
    const questions: string[] = [];
    const name = await resolveMemberName({
      envName: 'Ryan Huber',
      assumeYes: false,
      interactive: true,
      ask: async (question) => {
        questions.push(question);
        return '\n';
      },
    });

    expect(name).toBe('Ryan Huber');
    expect(questions[0]).toContain('[Ryan Huber]');
  });

  it('prefers the typed answer over the git name', async () => {
    await expect(
      resolveMemberName({
        envName: 'Ryan Huber',
        assumeYes: false,
        interactive: true,
        ask: async () => '  Someone Else ',
      }),
    ).resolves.toBe('Someone Else');
  });

  it('fails by name when there is nothing to fall back to and no terminal', async () => {
    await expect(
      resolveMemberName({ envName: '  ', assumeYes: false, interactive: false, ask: never }),
    ).rejects.toThrow(/no member name available/);
  });

  it('fails when the terminal answer is empty and there is no git name', async () => {
    await expect(
      resolveMemberName({
        envName: undefined,
        assumeYes: false,
        interactive: true,
        ask: async () => '',
      }),
    ).rejects.toThrow(/no member name available/);
  });
});

describe('registrationCommand', () => {
  it('returns the one-time registration command', () => {
    expect(registrationCommand(8765)).toBe(
      'claude mcp add -s user --transport http aion http://127.0.0.1:8765/mcp',
    );
  });
});

describe('registrationJson', () => {
  it('matches the shape Claude Code writes for an HTTP MCP server', () => {
    expect(JSON.parse(registrationJson(8765))).toEqual({
      mcpServers: { aion: { type: 'http', url: 'http://127.0.0.1:8765/mcp' } },
    });
  });
});
