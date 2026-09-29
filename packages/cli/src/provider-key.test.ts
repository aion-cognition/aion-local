import {
  DEFAULTS,
  loadConfig,
  parseEnvFile,
  type Config,
  type GenerationProvider,
} from '@aion/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  selectedProviderKey,
  keyNoticeLines,
  resolveProviderKey,
  settleProviderKey,
  type SettleKeyInput,
} from './provider-key.js';

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

let dir: string;
let envPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-provider-key-'));
  envPath = join(dir, '.env');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('selectedProviderKey', () => {
  it('settles the Anthropic key when nothing selects a provider', () => {
    expect(selectedProviderKey(loadConfig({ AION_ANTHROPIC_API_KEY: 'sk-ant' }))).toEqual({
      provider: 'anthropic',
      envVar: 'AION_ANTHROPIC_API_KEY',
      configured: 'sk-ant',
    });
  });

  it("settles the selected provider's key and never reads the other one", () => {
    expect(selectedProviderKey(keyed('openai', { anthropic: 'sk-ant' }))).toEqual({
      provider: 'openai',
      envVar: 'AION_OPENAI_API_KEY',
      configured: '',
    });
    expect(selectedProviderKey(keyed('anthropic', { openai: 'sk-oai' }))).toEqual({
      provider: 'anthropic',
      envVar: 'AION_ANTHROPIC_API_KEY',
      configured: '',
    });
  });
});

describe('resolveProviderKey', () => {
  it('takes an exported key without asking', async () => {
    await expect(
      resolveProviderKey({
        provider: 'openai',
        exported: ' sk-exported ',
        assumeYes: true,
        interactive: false,
        ask: never,
      }),
    ).resolves.toBe('sk-exported');
  });

  it('asks for a missing key on a terminal, naming the provider and its variable', async () => {
    const questions: string[] = [];
    const ask = async (question: string): Promise<string> => {
      questions.push(question);
      return '  sk-typed ';
    };
    for (const provider of ['anthropic', 'openai'] as const) {
      await expect(
        resolveProviderKey({ provider, exported: '', assumeYes: false, interactive: true, ask }),
      ).resolves.toBe('sk-typed');
    }
    expect(questions).toEqual([
      'anthropic API key (AION_ANTHROPIC_API_KEY, Enter to skip): ',
      'openai API key (AION_OPENAI_API_KEY, Enter to skip): ',
    ]);
  });

  it('leaves generation unavailable without asking in unattended setup', async () => {
    for (const provider of ['anthropic', 'openai'] as const) {
      await expect(
        resolveProviderKey({
          provider,
          exported: '',
          assumeYes: true,
          interactive: true,
          ask: never,
        }),
      ).resolves.toBeUndefined();
      await expect(
        resolveProviderKey({
          provider,
          exported: '',
          assumeYes: false,
          interactive: false,
          ask: never,
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('allows setup to continue when the optional key is skipped', async () => {
    await expect(
      resolveProviderKey({
        provider: 'openai',
        exported: '',
        assumeYes: false,
        interactive: true,
        ask: async () => '',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('settleProviderKey', () => {
  function settle(
    env: NodeJS.ProcessEnv,
    options: Partial<SettleKeyInput> = {},
  ): { run: () => Promise<Config>; written: string[]; config: Config } {
    const written: string[] = [];
    const config = loadConfig(env);
    const input: SettleKeyInput = {
      envPath,
      assumeYes: true,
      interactive: false,
      ask: never,
      write: (line) => {
        written.push(line);
      },
      ...options,
    };
    return { run: async () => await settleProviderKey(input, env), written, config };
  }

  it("records a typed key under the selected provider's variable and leaves the other alone", async () => {
    writeFileSync(
      envPath,
      'AION_GENERATION_PROVIDER=openai\nAION_ANTHROPIC_API_KEY=sk-ant-file\nAION_OPENAI_API_KEY=\n',
    );
    // What the native wrapper hands the CLI: the file's values, with nothing else exported.
    const env: NodeJS.ProcessEnv = {
      AION_GENERATION_PROVIDER: 'openai',
      AION_ANTHROPIC_API_KEY: 'sk-ant-file',
      AION_OPENAI_API_KEY: '',
    };
    const questions: string[] = [];
    const { run, written } = settle(env, {
      assumeYes: false,
      interactive: true,
      ask: async (question) => {
        questions.push(question);
        return 'sk-typed';
      },
    });

    const config = await run();

    expect(questions).toEqual(['openai API key (AION_OPENAI_API_KEY, Enter to skip): ']);
    expect(readFileSync(envPath, 'utf8')).toBe(
      'AION_GENERATION_PROVIDER=openai\nAION_ANTHROPIC_API_KEY=sk-ant-file\nAION_OPENAI_API_KEY=sk-typed\n',
    );
    expect(written).toEqual([`AION_OPENAI_API_KEY recorded in ${envPath}`]);
    expect(env.AION_OPENAI_API_KEY).toBe('sk-typed');
    expect(config.openai.apiKey).toBe('sk-typed');
    expect(config.anthropic.apiKey).toBe('sk-ant-file');
  });

  it('writes nothing when .env already holds the key, whatever the shell exports', async () => {
    const text = 'AION_GENERATION_PROVIDER=openai\nAION_OPENAI_API_KEY=sk-file\n';
    writeFileSync(envPath, text);
    const env: NodeJS.ProcessEnv = {
      AION_GENERATION_PROVIDER: 'openai',
      AION_OPENAI_API_KEY: 'sk-shell',
    };
    const { run, written } = settle(env);

    expect((await run()).openai.apiKey).toBe('sk-file');
    expect(readFileSync(envPath, 'utf8')).toBe(text);
    expect(written).toEqual([]);
    expect(env.AION_OPENAI_API_KEY).toBe('sk-shell');
  });

  it('records a key only the shell exports, since the service reads .env alone', async () => {
    writeFileSync(envPath, 'AION_GENERATION_PROVIDER=openai\n');
    const env: NodeJS.ProcessEnv = {
      AION_GENERATION_PROVIDER: 'openai',
      AION_OPENAI_API_KEY: 'sk-shell',
    };
    const { run, written } = settle(env);

    const config = await run();

    const recorded = parseEnvFile(readFileSync(envPath, 'utf8'));
    expect(recorded.get('AION_OPENAI_API_KEY')).toBe('sk-shell');
    expect(recorded.get('AION_GENERATION_PROVIDER')).toBe('openai');
    expect(written).toEqual([`AION_OPENAI_API_KEY recorded in ${envPath}`]);
    expect(config.openai.apiKey).toBe('sk-shell');
  });

  it('settles the provider .env selects, not one only the shell exports', async () => {
    writeFileSync(envPath, '# seeded from the template\n');
    const env: NodeJS.ProcessEnv = {
      AION_GENERATION_PROVIDER: 'openai',
      AION_OPENAI_API_KEY: 'sk-oai',
      AION_ANTHROPIC_API_KEY: 'sk-ant',
    };
    const { run } = settle(env);

    await run();

    const recorded = parseEnvFile(readFileSync(envPath, 'utf8'));
    expect(recorded.get('AION_ANTHROPIC_API_KEY')).toBe('sk-ant');
    expect(recorded.has('AION_OPENAI_API_KEY')).toBe(false);
  });

  it('keeps capture available without writing a key when setup is unattended', async () => {
    const text = 'AION_GENERATION_PROVIDER=openai\nAION_ANTHROPIC_API_KEY=sk-ant\n';
    writeFileSync(envPath, text);
    const { run, written } = settle({ AION_GENERATION_PROVIDER: 'openai' });

    expect((await run()).openai.apiKey).toBe('');
    expect(readFileSync(envPath, 'utf8')).toBe(text);
    expect(written).toEqual([]);
  });
});

describe('keyNoticeLines', () => {
  it('says nothing about keys when .env holds the selected provider key', () => {
    writeFileSync(envPath, 'AION_GENERATION_PROVIDER=openai\nAION_OPENAI_API_KEY=sk-oai\n');
    expect(keyNoticeLines(envPath, {})).toEqual([]);
    writeFileSync(envPath, 'AION_ANTHROPIC_API_KEY=sk-ant\n');
    expect(keyNoticeLines(envPath, {})).toEqual([]);
  });

  it('names the variable the selection needs, and that generation waits for it', () => {
    // The Anthropic key is recorded and does not count: only the selected provider's key does.
    writeFileSync(envPath, 'AION_GENERATION_PROVIDER=openai\nAION_ANTHROPIC_API_KEY=sk-ant\n');
    const text = keyNoticeLines(envPath, {}).join(' ');
    expect(text).toContain('AION_GENERATION_PROVIDER=openai needs AION_OPENAI_API_KEY');
    expect(text).toContain('Generation waits for a key');
    expect(text).toContain('`aion init` records it');
    expect(text).not.toMatch(/local route|Anthropic/);
  });

  it('still names it when only the shell exports the key, which the service never reads', () => {
    writeFileSync(envPath, 'AION_GENERATION_PROVIDER=openai\nAION_OPENAI_API_KEY=\n');
    const env = { AION_GENERATION_PROVIDER: 'openai', AION_OPENAI_API_KEY: 'sk-shell' };
    expect(keyNoticeLines(envPath, env).join(' ')).toContain(
      'AION_GENERATION_PROVIDER=openai needs AION_OPENAI_API_KEY',
    );
  });

  it('reads an unset selector as Anthropic, with or without a .env', () => {
    expect(keyNoticeLines(envPath, {}).join(' ')).toContain(
      'AION_GENERATION_PROVIDER=anthropic needs AION_ANTHROPIC_API_KEY',
    );
    writeFileSync(envPath, 'AION_ANTHROPIC_API_KEY=\n');
    expect(keyNoticeLines(envPath, {}).join(' ')).toContain(
      'AION_GENERATION_PROVIDER=anthropic needs AION_ANTHROPIC_API_KEY',
    );
  });
});
