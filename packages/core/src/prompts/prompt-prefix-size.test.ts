import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MIN_CACHEABLE_PREFIX_CHARS,
  MIN_CACHEABLE_PREFIX_TOKENS,
  prefixReachesCacheFloor,
} from '../infrastructure/providers/anthropic-cache.js';

/**
 * What every surface's system prefix actually measures, against the floor below which the API
 * caches nothing.
 *
 * The prefix a call sends is the surface's system prompt plus the schema instruction, so the
 * prompt text is a lower bound on it. This measures that bound, prints it, and holds the
 * verdict the provider acts on: not one shipped prompt reaches the floor, which is why no
 * shipped call carries a cache marker.
 *
 * A surface that grows past the floor fails this file, which is the intended way to find out:
 * the fix is to read the new number and let the marker attach, never to pad a prompt up to it.
 *
 * Parameterized surfaces export builders rather than constants and are not measured here. Their
 * fixed text is shorter than the constants beside them, and a builder's rendered length is a
 * property of its arguments; `aion costs` reads what any call actually cached.
 */

const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));

const FILES = readdirSync(PROMPT_DIR).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && file !== 'index.ts',
);

type Measured = {
  readonly surface: string;
  readonly chars: number;
  readonly cacheable: boolean;
};

async function measureAll(): Promise<readonly Measured[]> {
  const measured: Measured[] = [];
  for (const file of FILES) {
    const module = (await import(join(PROMPT_DIR, file))) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (typeof value !== 'string') {
        continue;
      }
      measured.push({
        surface: `${file.replace('.ts', '')}:${name}`,
        chars: value.length,
        cacheable: prefixReachesCacheFloor(value),
      });
    }
  }
  return measured.sort((left, right) => right.chars - left.chars);
}

describe('what a cached prefix would have to be', () => {
  it('measures every shipped system prompt against the cache floor', async () => {
    const measured = await measureAll();
    const longest = measured[0];

    console.log(
      `prompt prefixes measured: ${String(measured.length)}; longest ` +
        `${longest?.surface ?? 'none'} at ${String(longest?.chars ?? 0)} chars against a ` +
        `${String(MIN_CACHEABLE_PREFIX_CHARS)}-char floor ` +
        `(~${String(MIN_CACHEABLE_PREFIX_TOKENS)} tokens)`,
    );

    expect(measured.length).toBeGreaterThan(10);
    expect(measured.filter((entry) => entry.cacheable)).toEqual([]);
  });

  it('marks a prefix that does reach the floor', () => {
    expect(prefixReachesCacheFloor('x'.repeat(MIN_CACHEABLE_PREFIX_CHARS))).toBe(true);
    expect(prefixReachesCacheFloor('x'.repeat(MIN_CACHEABLE_PREFIX_CHARS - 1))).toBe(false);
  });
});
