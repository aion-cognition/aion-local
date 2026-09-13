import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { allocatedSurfaces, frameFor } from './frame.js';

/**
 * The allocation is keyed on the `surface` string a call site sends, so a surface named on one
 * side and not the other falls through to the concise rendering and says nothing about it. This
 * scan is what says so: every surface the workspace sends is either allocated or deliberately
 * absent from this file's own list, and every key the allocation holds is a surface something
 * actually sends.
 */

const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Surfaces that legitimately read the concise default and are not in the allocation.
 *
 * `unlabeled` is what a caller that named none is charged under. The three probes are the
 * routing and cache checks, which send a fixed one-token request and read nothing. `batch_probe`
 * and `batch_submission` are the lane's own accounting labels rather than generation surfaces.
 */
const UNALLOCATED: readonly string[] = [
  'unlabeled',
  'probe',
  'cache-probe',
  'batch-probe',
  'batch_submission',
  'background',
];

function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist') {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.includes('.test.') && !entry.includes('.fixture.')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every surface name the shipped code writes: the literals a request carries inline, and the
 * `*_SURFACE` constants a call site sends instead of a literal.
 */
function sentSurfaces(): readonly string[] {
  const pattern = /(?:surface(?::| \?\?)|_SURFACE =) '([a-z0-9_-]+)'/g;
  const found = new Set<string>();
  for (const file of sourceFiles(PACKAGES)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      found.add(match[1]!);
    }
  }
  return [...found].sort();
}

describe('the frame allocation', () => {
  it('reads the workspace rather than an empty directory', () => {
    expect(sentSurfaces().length).toBeGreaterThan(15);
  });

  it('names every surface the workspace sends, or lists it as one that reads the default', () => {
    const allocated = new Set(allocatedSurfaces());
    const exempt = new Set(UNALLOCATED);
    const unaccounted = sentSurfaces().filter(
      (surface) => !allocated.has(surface) && !exempt.has(surface),
    );

    expect(unaccounted).toEqual([]);
  });

  it('allocates nothing that no call site sends', () => {
    const sent = new Set(sentSurfaces());

    expect(allocatedSurfaces().filter((surface) => !sent.has(surface))).toEqual([]);
  });

  it('reads an unallocated surface as concise rather than failing', () => {
    for (const surface of UNALLOCATED) {
      expect(frameFor(surface)).toBe('concise');
    }
  });
});
