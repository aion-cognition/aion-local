import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One text per prompt, across every surface in this directory.
 *
 * Each surface used to export its text twice, under `LOCAL` and `KEYED`, so a route serving a
 * small local model could read different words from the one serving the remote model. There is
 * no local generation route any more: every provider the service builds reports the one remote
 * model, so the local name was an alias on most surfaces and unreachable text on three. The
 * aliases are collapsed to one exported name with both callers moved onto it, and the three real
 * forks are gone with a line in each file saying what stood there.
 *
 * What this file holds is the shape that replaced them. No surface exports a `_LOCAL`/`_KEYED`
 * pair, every exported prompt is reachable under one name, and a surface added to the directory
 * is swept by the same scan rather than by a list somebody has to remember to extend.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function surfaceFiles(): readonly string[] {
  return readdirSync(HERE)
    .filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.int.test.ts') &&
        name !== 'index.ts',
    )
    .sort();
}

type Exported = {
  readonly surface: string;
  readonly name: string;
  readonly value: unknown;
};

async function exportedPrompts(): Promise<readonly Exported[]> {
  const found: Exported[] = [];
  for (const file of surfaceFiles()) {
    const module = (await import(join(HERE, file))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      found.push({ surface: file.replace('.ts', ''), name, value });
    }
  }
  return found;
}

/** A route word in an export name is what a fork looks like from outside the file. */
const ROUTE_SUFFIXES = ['_LOCAL', '_KEYED'];

describe('the prompt surfaces', () => {
  it('reads the directory rather than an empty one', () => {
    expect(surfaceFiles().length).toBe(20);
  });

  it('exports no prompt under a route-specific name', async () => {
    const forked = (await exportedPrompts())
      .filter((entry) => ROUTE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix)))
      .map((entry) => `${entry.surface}: ${entry.name}`);

    expect(forked).toEqual([]);
  });

  it('exports at least one prompt from every surface file', async () => {
    const prompts = await exportedPrompts();
    const withText = new Set(
      prompts
        .filter((entry) => typeof entry.value === 'string' || typeof entry.value === 'function')
        .map((entry) => entry.surface),
    );

    expect([...withText].sort()).toEqual(surfaceFiles().map((file) => file.replace('.ts', '')));
  });

  it('names every prompt constant for what it is rather than for a route', async () => {
    const prompts = (await exportedPrompts()).filter((entry) => typeof entry.value === 'string');
    const unnamed = prompts
      .filter((entry) => entry.name === 'LOCAL' || entry.name === 'KEYED')
      .map((entry) => entry.surface);

    expect(unnamed).toEqual([]);
    expect(prompts.length).toBeGreaterThan(10);
  });

  it('catches a route-specific name the scan would otherwise let through', () => {
    const planted: readonly Exported[] = [
      { surface: 'planted', name: 'DETECT_KEYED', value: 'some text' },
    ];

    expect(
      planted.filter((entry) => ROUTE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))),
    ).toHaveLength(1);
  });
});
