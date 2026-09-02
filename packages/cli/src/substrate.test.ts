import { DEFAULTS, openLogger } from '@aion/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stdoutWriter } from './output.js';

/**
 * `close()` is what every command's `finally` runs, so a rejection or a thrown error out of it
 * would replace whatever the command was already returning. Both resources here are faked so a
 * failing driver close is decided by the test, not by whether a real one happens to throw.
 */

const seam = vi.hoisted(() => ({
  driverCloseError: undefined as Error | undefined,
  storeCloseError: undefined as Error | undefined,
  driverClosed: false,
  storeClosed: false,
}));

vi.mock('@aion/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    GraphConnection: class {
      async close(): Promise<void> {
        seam.driverClosed = true;
        if (seam.driverCloseError !== undefined) {
          throw seam.driverCloseError;
        }
      }
    },
    SqliteStore: class {
      readonly db = {};
      close(): void {
        seam.storeClosed = true;
        if (seam.storeCloseError !== undefined) {
          throw seam.storeCloseError;
        }
      }
    },
  };
});

const { Substrate } = await import('./substrate.js');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-substrate-'));
  seam.driverCloseError = undefined;
  seam.storeCloseError = undefined;
  seam.driverClosed = false;
  seam.storeClosed = false;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function openSubstrate(): InstanceType<typeof Substrate> {
  const config = {
    ...DEFAULTS,
    logging: { ...DEFAULTS.logging, filePath: join(dir, 'aion.jsonl') },
  };
  return new Substrate(config, 'substrate-test', stdoutWriter);
}

describe('Substrate.close', () => {
  it('closes the database even when the driver close rejects', async () => {
    const substrate = openSubstrate();
    substrate.connection();
    substrate.db();
    seam.driverCloseError = new Error('driver exploded');

    await expect(substrate.close()).resolves.toBeUndefined();

    expect(seam.driverClosed).toBe(true);
    expect(seam.storeClosed).toBe(true);
  });

  it('still reports success when only the database close throws', async () => {
    const substrate = openSubstrate();
    substrate.connection();
    substrate.db();
    seam.storeCloseError = new Error('database busy');

    await expect(substrate.close()).resolves.toBeUndefined();

    expect(seam.driverClosed).toBe(true);
    expect(seam.storeClosed).toBe(true);
  });

  it('logs a failed close rather than swallowing it silently', async () => {
    const substrate = openSubstrate();
    substrate.connection();
    const logger = openLogger({ filePath: join(dir, 'aion.jsonl'), level: 'warn' });
    const warn = vi.spyOn(logger, 'warn');
    vi.spyOn(substrate, 'logger').mockReturnValue(logger);
    seam.driverCloseError = new Error('driver exploded');

    await substrate.close();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'failed to close the graph driver',
    );
  });
});
