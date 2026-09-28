import { DEFAULTS, loadConfig, type Config, type GenerationProvider } from '@aion/core';
import { describe, expect, it } from 'vitest';

import { parseInitFlags, resolveInitProfile } from './init.js';
import { resolveMemberName } from './member-name.js';
import { fullProfileKey, keyNoticeLines, resolveProviderKey } from './provider-key.js';
import { registrationCommand, registrationJson } from './registration.js';

const never = async (): Promise<string> => {
  throw new Error('prompt must not run');
};

/** Each key set or left empty on its own, so a test can give a key to the provider not selected. */
function keyed(
  provider: GenerationProvider,
  keys: { anthropic?: string; openai?: string },
): Config {
  return {
    ...DEFAULTS,
    generation: { ...DEFAULTS.generation, provider },
    anthropic: { ...DEFAULTS.anthropic, apiKey: keys.anthropic ?? '' },
    openai: { ...DEFAULTS.openai, apiKey: keys.openai ?? '' },
  };
}

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

describe('fullProfileKey', () => {
  it('settles the Anthropic key when nothing selects a provider', () => {
    expect(fullProfileKey(loadConfig({ AION_ANTHROPIC_API_KEY: 'sk-ant' }))).toEqual({
      provider: 'anthropic',
      envVar: 'AION_ANTHROPIC_API_KEY',
      configured: 'sk-ant',
    });
  });

  it("settles the selected provider's key and never reads the other one", () => {
    expect(fullProfileKey(keyed('openai', { anthropic: 'sk-ant' }))).toEqual({
      provider: 'openai',
      envVar: 'AION_OPENAI_API_KEY',
      configured: '',
    });
    expect(fullProfileKey(keyed('anthropic', { openai: 'sk-oai' }))).toEqual({
      provider: 'anthropic',
      envVar: 'AION_ANTHROPIC_API_KEY',
      configured: '',
    });
  });
});

describe('resolveProviderKey', () => {
  it('prefers the configured key, then the one already in .env', async () => {
    await expect(
      resolveProviderKey({
        provider: 'openai',
        configured: 'sk-configured',
        fromEnvFile: 'sk-file',
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('sk-configured');
    await expect(
      resolveProviderKey({
        provider: 'openai',
        configured: '',
        fromEnvFile: 'sk-file',
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('sk-file');
  });

  it('asks for a missing key on a terminal, naming the provider and its variable', async () => {
    const questions: string[] = [];
    const ask = async (question: string): Promise<string> => {
      questions.push(question);
      return '  sk-typed ';
    };
    for (const provider of ['anthropic', 'openai'] as const) {
      await expect(
        resolveProviderKey({
          provider,
          configured: '',
          fromEnvFile: undefined,
          assumeYes: false,
          interactive: true,
          ask,
        }),
      ).resolves.toBe('sk-typed');
    }
    expect(questions).toEqual([
      'anthropic API key (AION_ANTHROPIC_API_KEY): ',
      'openai API key (AION_OPENAI_API_KEY): ',
    ]);
  });

  it('fails naming the selected provider and its variable under --yes', async () => {
    await expect(
      resolveProviderKey({
        provider: 'openai',
        configured: '',
        fromEnvFile: undefined,
        assumeYes: true,
        interactive: true,
        ask: never,
      }),
    ).rejects.toThrow(
      'the full profile needs AION_OPENAI_API_KEY for AION_GENERATION_PROVIDER=openai.',
    );
    await expect(
      resolveProviderKey({
        provider: 'anthropic',
        configured: '',
        fromEnvFile: undefined,
        assumeYes: false,
        interactive: false,
        ask: never,
      }),
    ).rejects.toThrow(
      'the full profile needs AION_ANTHROPIC_API_KEY for AION_GENERATION_PROVIDER=anthropic.',
    );
  });

  it('fails the same way when the terminal answer is empty', async () => {
    await expect(
      resolveProviderKey({
        provider: 'openai',
        configured: '',
        fromEnvFile: undefined,
        assumeYes: false,
        interactive: true,
        ask: async () => '',
      }),
    ).rejects.toThrow(/needs AION_OPENAI_API_KEY for AION_GENERATION_PROVIDER=openai/);
  });
});

describe('keyNoticeLines', () => {
  it('says nothing about keys when the selected provider has one', () => {
    expect(keyNoticeLines(keyed('openai', { openai: 'sk-oai' }))).toEqual([]);
    expect(keyNoticeLines(keyed('anthropic', { anthropic: 'sk-ant' }))).toEqual([]);
  });

  it('names the variable the selection needs, and that generation waits for it', () => {
    // The Anthropic key is set and does not count: only the selected provider's key does.
    const text = keyNoticeLines(keyed('openai', { anthropic: 'sk-ant' })).join(' ');
    expect(text).toContain('AION_GENERATION_PROVIDER=openai needs AION_OPENAI_API_KEY');
    expect(text).toContain('Generation waits for a key');
    expect(text).toContain('`aion init full` records it');
    expect(text).not.toMatch(/local route|Anthropic/);
  });

  it('reads an unset selector as Anthropic', () => {
    const text = keyNoticeLines(loadConfig({})).join(' ');
    expect(text).toContain('AION_GENERATION_PROVIDER=anthropic needs AION_ANTHROPIC_API_KEY');
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
