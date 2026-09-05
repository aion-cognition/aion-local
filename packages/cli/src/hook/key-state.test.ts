import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { anthropicKeyState } from './key-state.js';

describe('anthropicKeyState', () => {
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
    expect(anthropicKeyState({ AION_ANTHROPIC_API_KEY: 'sk-exported' }, undefined)).toBe('present');
  });

  it('reads a blank exported key as no key at all', () => {
    envFile('AION_ANTHROPIC_API_KEY=sk-from-file\n');

    expect(anthropicKeyState({ AION_ANTHROPIC_API_KEY: '   ' }, scriptPath)).toBe('present');
  });

  it('finds the key in the repo .env four directories above the script', () => {
    envFile('# the keyed profile\nAION_ANTHROPIC_API_KEY=sk-from-file\nAION_MCP_PORT=8765\n');

    expect(anthropicKeyState({}, scriptPath)).toBe('present');
  });

  it('strips one pair of quotes around the recorded value', () => {
    envFile('AION_ANTHROPIC_API_KEY="sk-quoted"\n');

    expect(anthropicKeyState({}, scriptPath)).toBe('present');
  });

  it('calls a readable file with no key of ours absent', () => {
    envFile('NEO4J_PASSWORD=hunter2\n');

    expect(anthropicKeyState({}, scriptPath)).toBe('absent');
  });

  it('calls an empty value absent, quoted or bare', () => {
    envFile('AION_ANTHROPIC_API_KEY=\n');
    expect(anthropicKeyState({}, scriptPath)).toBe('absent');

    envFile('AION_ANTHROPIC_API_KEY=""\n');
    expect(anthropicKeyState({}, scriptPath)).toBe('absent');
  });

  it('calls a commented-out key absent', () => {
    envFile('# AION_ANTHROPIC_API_KEY=sk-was-here\n');

    expect(anthropicKeyState({}, scriptPath)).toBe('absent');
  });

  it('takes the last line for a key the file records twice', () => {
    envFile('AION_ANTHROPIC_API_KEY=sk-first\nAION_ANTHROPIC_API_KEY=\n');

    expect(anthropicKeyState({}, scriptPath)).toBe('absent');
  });

  it('answers unknown when there is no .env to read', () => {
    expect(anthropicKeyState({}, scriptPath)).toBe('unknown');
  });

  it('answers unknown when nothing names the script', () => {
    envFile('AION_ANTHROPIC_API_KEY=sk-from-file\n');

    expect(anthropicKeyState({}, undefined)).toBe('unknown');
    expect(anthropicKeyState({}, '')).toBe('unknown');
  });
});
