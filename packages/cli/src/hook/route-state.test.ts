import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generationRoute } from './route-state.js';

describe('generationRoute', () => {
  let dir: string;
  let repoDir: string;
  let scriptPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-key-state-'));
    repoDir = join(dir, 'repo');
    scriptPath = join(repoDir, 'packages', 'cli', 'dist', 'hook-main.js');
    mkdirSync(join(repoDir, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(scriptPath, '#!/usr/bin/env node\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function envFile(text: string): void {
    writeFileSync(join(repoDir, '.env'), text);
  }

  it('reads an exported key as present without looking at any file', () => {
    expect(generationRoute({ AION_ANTHROPIC_API_KEY: 'sk-exported' }, undefined)).toBe('keyed');
  });

  it('reads a blank exported key as no key at all', () => {
    envFile('AION_ANTHROPIC_API_KEY=sk-from-file\n');

    expect(generationRoute({ AION_ANTHROPIC_API_KEY: '   ' }, scriptPath)).toBe('keyed');
  });

  it('finds the key in the repo .env four directories above the script', () => {
    envFile('# the keyed profile\nAION_ANTHROPIC_API_KEY=sk-from-file\nAION_MCP_PORT=8765\n');

    expect(generationRoute({}, scriptPath)).toBe('keyed');
  });

  it('strips one pair of quotes around the recorded value', () => {
    envFile('AION_ANTHROPIC_API_KEY="sk-quoted"\n');

    expect(generationRoute({}, scriptPath)).toBe('keyed');
  });

  it('calls a readable file with no key of ours absent', () => {
    envFile('NEO4J_PASSWORD=hunter2\n');

    expect(generationRoute({}, scriptPath)).toBe('local');
  });

  it('calls an empty value absent, quoted or bare', () => {
    envFile('AION_ANTHROPIC_API_KEY=\n');
    expect(generationRoute({}, scriptPath)).toBe('local');

    envFile('AION_ANTHROPIC_API_KEY=""\n');
    expect(generationRoute({}, scriptPath)).toBe('local');
  });

  it('calls a commented-out key absent', () => {
    envFile('# AION_ANTHROPIC_API_KEY=sk-was-here\n');

    expect(generationRoute({}, scriptPath)).toBe('local');
  });

  it('takes the last line for a key the file records twice', () => {
    envFile('AION_ANTHROPIC_API_KEY=sk-first\nAION_ANTHROPIC_API_KEY=\n');

    expect(generationRoute({}, scriptPath)).toBe('local');
  });

  it('answers unknown when there is no .env to read', () => {
    expect(generationRoute({}, scriptPath)).toBe('unknown');
  });

  it('answers unknown when nothing names the script', () => {
    envFile('AION_ANTHROPIC_API_KEY=sk-from-file\n');

    expect(generationRoute({}, undefined)).toBe('unknown');
    expect(generationRoute({}, '')).toBe('unknown');
  });
  it('answers for the selected provider, not for whichever key is set', () => {
    expect(
      generationRoute({ AION_OPENAI_API_KEY: 'sk-openai', AION_ANTHROPIC_API_KEY: '' }, undefined),
    ).toBe('unknown');
    expect(
      generationRoute(
        { AION_GENERATION_PROVIDER: 'openai', AION_OPENAI_API_KEY: 'sk-openai' },
        undefined,
      ),
    ).toBe('keyed');
  });
});
