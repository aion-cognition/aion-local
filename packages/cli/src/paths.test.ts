import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envFilePath, envTemplatePath, RepoNotFoundError, resolveRepoDir } from './paths.js';

describe('resolveRepoDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-paths-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the working directory when it holds compose.yaml', () => {
    writeFileSync(join(dir, 'compose.yaml'), 'name: aion\n');

    expect(resolveRepoDir(dir)).toBe(dir);
  });

  it('fails by name when no candidate holds compose.yaml', () => {
    expect(() => resolveRepoDir(dir)).toThrow(RepoNotFoundError);
  });

  it('derives the env paths from the repo directory', () => {
    expect(envFilePath('/repo')).toBe('/repo/.env');
    expect(envTemplatePath('/repo')).toBe('/repo/.env.example');
  });
});
