import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyEnvDefaults, envFileValue, parseEnvFile } from './env-file.js';

describe('parseEnvFile', () => {
  it('reads a plain KEY=VALUE line', () => {
    expect(parseEnvFile('AION_ANTHROPIC_MODEL=claude-haiku-4-5').get('AION_ANTHROPIC_MODEL')).toBe(
      'claude-haiku-4-5',
    );
  });

  it('trims the space around a key and its value', () => {
    expect(parseEnvFile('  KEY = value  ').get('KEY')).toBe('value');
  });

  it('strips one pair of matching quotes and leaves anything else literal', () => {
    const values = parseEnvFile(`SINGLE='one'\nDOUBLE="two"\nMIXED="three'`);

    expect(values.get('SINGLE')).toBe('one');
    expect(values.get('DOUBLE')).toBe('two');
    expect(values.get('MIXED')).toBe(`"three'`);
  });

  it('splits on the first = so a value keeps its own', () => {
    expect(parseEnvFile('KEY=a=b=c').get('KEY')).toBe('a=b=c');
  });

  it('skips comments, blank lines, and a line with no =', () => {
    const values = parseEnvFile('# a comment\n\nBARE\nKEY=value\n');

    expect([...values.keys()]).toEqual(['KEY']);
  });

  it('reads an empty file as no values', () => {
    expect(parseEnvFile('').size).toBe(0);
  });

  it('lets the last line for a key win', () => {
    expect(parseEnvFile('KEY=first\nKEY=second').get('KEY')).toBe('second');
  });
});

describe('envFileValue', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-env-file-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a key the file holds', () => {
    const path = join(dir, '.env');
    writeFileSync(path, 'NEO4J_PASSWORD=secret\nAION_ANTHROPIC_API_KEY=sk-file\n');

    expect(envFileValue(path, 'AION_ANTHROPIC_API_KEY')).toBe('sk-file');
  });

  it('returns undefined for a key the file does not hold', () => {
    const path = join(dir, '.env');
    writeFileSync(path, 'NEO4J_PASSWORD=secret\n');

    expect(envFileValue(path, 'AION_ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('returns undefined when the file is missing', () => {
    expect(envFileValue(join(dir, 'absent.env'), 'AION_ANTHROPIC_API_KEY')).toBeUndefined();
  });

  it('returns undefined when the path is a directory rather than a file', () => {
    expect(envFileValue(dir, 'AION_ANTHROPIC_API_KEY')).toBeUndefined();
  });
});

describe('applyEnvDefaults', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-env-file-'));
    path = join(dir, '.env');
    writeFileSync(path, 'AION_ANTHROPIC_API_KEY=sk-file\nAION_REFLECT_PROVIDER=ollama\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fills a key the environment leaves unset', () => {
    const env: NodeJS.ProcessEnv = {};

    applyEnvDefaults(path, ['AION_ANTHROPIC_API_KEY'], env);

    expect(env.AION_ANTHROPIC_API_KEY).toBe('sk-file');
  });

  it('leaves a value the environment already carries', () => {
    const env: NodeJS.ProcessEnv = { AION_ANTHROPIC_API_KEY: 'sk-exported' };

    applyEnvDefaults(path, ['AION_ANTHROPIC_API_KEY'], env);

    expect(env.AION_ANTHROPIC_API_KEY).toBe('sk-exported');
  });

  it('treats a blank value as unset', () => {
    const env: NodeJS.ProcessEnv = { AION_ANTHROPIC_API_KEY: '   ' };

    applyEnvDefaults(path, ['AION_ANTHROPIC_API_KEY'], env);

    expect(env.AION_ANTHROPIC_API_KEY).toBe('sk-file');
  });

  it('touches no key outside the list it was given', () => {
    const env: NodeJS.ProcessEnv = {};

    applyEnvDefaults(path, ['AION_ANTHROPIC_API_KEY'], env);

    expect(env.AION_REFLECT_PROVIDER).toBeUndefined();
  });

  it('leaves the environment alone when a listed key is absent from the file', () => {
    const env: NodeJS.ProcessEnv = {};

    applyEnvDefaults(path, ['AION_ANTHROPIC_MODEL'], env);

    expect('AION_ANTHROPIC_MODEL' in env).toBe(false);
  });

  it('does nothing when the file is missing', () => {
    const env: NodeJS.ProcessEnv = {};

    applyEnvDefaults(join(dir, 'absent.env'), ['AION_ANTHROPIC_API_KEY'], env);

    expect(env).toEqual({});
  });
});
