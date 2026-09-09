import { DEFAULTS, openSqliteHandle, type GraphConnection } from '@aion/core';
import {
  activateCoverageContract,
  prepareCoverageContract,
} from '@aion/core/infrastructure/sqlite/coverage-contract.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSearch } from './search.js';
import type { Substrate, SubstrateCommand } from './substrate.js';

/**
 * What a refused search costs on the command line: nothing. The coverage decision comes before
 * the embedding call, so the seam that would have spent it is never reached, and the refusal is
 * what the operator reads instead of "no matches".
 */

const seam = vi.hoisted(() => ({ embedded: [] as string[][] }));

vi.mock('@aion/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    OllamaProvider: class {
      embed(texts: readonly string[]): Promise<number[][]> {
        seam.embedded.push([...texts]);
        return Promise.resolve(texts.map(() => [1, 0, 0]));
      }
    },
  };
});

vi.mock('./substrate.js', () => ({
  withSubstrate: async (command: SubstrateCommand<unknown>): Promise<number> =>
    await command.run(stubSubstrate(), command.parse(command.argv)),
}));

let db: ReturnType<typeof openSqliteHandle>;

function stubSubstrate(): Substrate {
  const noop = (): void => {
    // The command logs; nothing here reads it.
  };
  return {
    config: DEFAULTS,
    write: noop,
    logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }),
    connection: () => ({ driver: {} }) as unknown as GraphConnection,
    db: () => db,
  } as unknown as Substrate;
}

beforeEach(() => {
  seam.embedded.length = 0;
  db = openSqliteHandle({ filePath: ':memory:' });
  prepareCoverageContract(db, 1);
  activateCoverageContract(db, {
    activatedAt: new Date('2026-09-08T02:00:00.000Z'),
    fieldPolicyVersion: 1,
  });
});

describe('a search outside what the substrate covers', () => {
  it('refuses before it embeds anything and says why', async () => {
    const lines: string[] = [];

    const exit = await runSearch(
      ['webhooks', '--knew-at', '2026-01-01T00:00:00.000Z'],
      (line: string) => lines.push(line),
    );

    expect(exit).toBe(1);
    expect(seam.embedded).toEqual([]);
    expect(lines.join('\n')).toContain('before_horizon');
    expect(lines.join('\n')).not.toContain('no matches');
  });

  it('refuses a present search the same way when the registry cannot be read', async () => {
    db.prepare('ALTER TABLE coverage_contract RENAME TO coverage_contract_hidden').run();
    const lines: string[] = [];

    const exit = await runSearch(['webhooks'], (line: string) => lines.push(line));

    expect(exit).toBe(1);
    expect(seam.embedded).toEqual([]);
    expect(lines.join('\n')).toContain('coverage_store_unavailable');
  });
});
