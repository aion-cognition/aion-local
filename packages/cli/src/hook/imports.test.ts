import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOOK_DIR = fileURLToPath(new URL('.', import.meta.url));

const FROM_IMPORT = /^\s*(?:import|export)\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
const BARE_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm;

function specifiersIn(source: string): readonly string[] {
  const found: string[] = [];
  for (const pattern of [FROM_IMPORT, BARE_IMPORT]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      found.push(match[1] ?? '');
      match = pattern.exec(source);
    }
  }
  return found;
}

function productionFiles(): readonly string[] {
  return readdirSync(HOOK_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

describe('the hook subtree', () => {
  it('imports node builtins and its own siblings only', () => {
    const offenders: string[] = [];
    for (const name of productionFiles()) {
      const source = readFileSync(join(HOOK_DIR, name), 'utf8');
      for (const specifier of specifiersIn(source)) {
        const local = specifier.startsWith('./') || specifier.startsWith('../');
        if (!local && !specifier.startsWith('node:')) {
          offenders.push(`${name}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('scans every file it is supposed to, so an empty pass cannot look like a clean one', () => {
    expect(productionFiles().length).toBeGreaterThanOrEqual(6);
  });
});
