import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The substrate's second load-bearing guarantee (PRD §5.5): supersession closes a node,
 * forgetting closes a node, and nothing deletes one. A repo-wide scan is the cheapest place
 * to hold that line, because the rule has to survive every future task that writes Cypher.
 * This file is the sole exception, since it has to name the patterns it forbids.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const THIS_FILE = fileURLToPath(import.meta.url);

const FORBIDDEN = [
  { name: 'DETACH DELETE', pattern: /\bDETACH\s+DELETE\b/ },
  { name: 'DELETE clause', pattern: /\bDELETE\s+[A-Za-z_]/ },
];

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        found.push(...collectSourceFiles(path));
      }
    } else if (entry.name.endsWith('.ts') && path !== THIS_FILE) {
      found.push(path);
    }
  }
  return found;
}

describe('no code path hard-deletes a node', () => {
  const files = collectSourceFiles(PACKAGES_DIR);

  it('scans every TypeScript source file in the workspace', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => relative(REPO_ROOT, file).startsWith(`packages${sep}core`))).toBe(true);
  });

  it('finds no Cypher delete anywhere outside this test', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${relative(REPO_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
