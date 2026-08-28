import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from 'neo4j-driver';
import {
  MANAGED_NEO4J_URI,
  Neo4jGdsUnavailableError,
  Neo4jNotReadyError,
  ensureNeo4jPassword,
  generateStrongPassword,
  isManagedNeo4jUri,
  verifyGdsAvailable,
  waitForBoltReady,
} from './provision.js';

describe('isManagedNeo4jUri', () => {
  it('is true for the compose in-container URI', () => {
    expect(isManagedNeo4jUri(MANAGED_NEO4J_URI)).toBe(true);
  });

  it('is false for any other URI, e.g. a bare-metal escape hatch', () => {
    expect(isManagedNeo4jUri('bolt://localhost:7687')).toBe(false);
  });
});

describe('generateStrongPassword', () => {
  it('produces a long, dotenv-safe, non-empty string', () => {
    const password = generateStrongPassword();
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is not deterministic across calls', () => {
    expect(generateStrongPassword()).not.toBe(generateStrongPassword());
  });
});

describe('waitForBoltReady', () => {
  it('throws a named error within the timeout when nothing is listening', async () => {
    const endpoint = { uri: 'bolt://127.0.0.1:1', password: 'irrelevant' };
    await expect(
      waitForBoltReady(endpoint, { timeoutMs: 300, pollIntervalMs: 100 }),
    ).rejects.toThrow(Neo4jNotReadyError);
  });
});

describe('verifyGdsAvailable', () => {
  function fakeDriver(records: Array<{ gdsVersion?: string }>): Driver {
    return {
      executeQuery: async () => ({
        records: records.map((row) => ({
          get: (key: string) => (key === 'gdsVersion' ? row.gdsVersion : undefined),
        })),
      }),
    } as unknown as Driver;
  }

  it('returns the reported version when gds.version() succeeds', async () => {
    const driver = fakeDriver([{ gdsVersion: '2026.07.0' }]);
    await expect(verifyGdsAvailable(driver, 'bolt://x')).resolves.toBe('2026.07.0');
  });

  it('throws Neo4jGdsUnavailableError when the call itself fails', async () => {
    const driver = {
      executeQuery: async () => {
        throw new Error('unknown procedure');
      },
    } as unknown as Driver;
    await expect(verifyGdsAvailable(driver, 'bolt://x')).rejects.toThrow(Neo4jGdsUnavailableError);
  });

  it('throws Neo4jGdsUnavailableError when the call returns no rows', async () => {
    const driver = fakeDriver([]);
    await expect(verifyGdsAvailable(driver, 'bolt://x')).rejects.toThrow(Neo4jGdsUnavailableError);
  });
});

describe('ensureNeo4jPassword', () => {
  let dir: string;
  let envPath: string;
  let templatePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-provision-'));
    envPath = join(dir, '.env');
    templatePath = join(dir, '.env.example');
    writeFileSync(templatePath, 'AION_OLLAMA_URL=http://host.docker.internal:11434\nAION_NEO4J_PASSWORD=\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .env from the template and fills the password when both are absent', () => {
    const password = ensureNeo4jPassword(envPath, templatePath);
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('AION_OLLAMA_URL=http://host.docker.internal:11434');
    expect(content).toContain(`AION_NEO4J_PASSWORD=${password}`);
  });

  it('writes only the password line when no template is given', () => {
    const password = ensureNeo4jPassword(envPath);
    expect(readFileSync(envPath, 'utf8')).toBe(`AION_NEO4J_PASSWORD=${password}`);
  });

  it('leaves an existing password untouched on re-run (idempotent init)', () => {
    writeFileSync(envPath, 'AION_NEO4J_PASSWORD=already-set\nAION_MCP_PORT=8765\n');
    const password = ensureNeo4jPassword(envPath, templatePath);
    expect(password).toBe('already-set');
    expect(readFileSync(envPath, 'utf8')).toBe('AION_NEO4J_PASSWORD=already-set\nAION_MCP_PORT=8765\n');
  });

  it('generates once and returns the same value on a second call', () => {
    const first = ensureNeo4jPassword(envPath, templatePath);
    const second = ensureNeo4jPassword(envPath, templatePath);
    expect(second).toBe(first);
  });
});
