import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repo's comment rule, enforced the way `no-hard-delete.test.ts` enforces its own: by a
 * scan, because the rule is a review-time convention until something reads every file. A
 * finding id names a document outside the repo that a reader of the code cannot open and that
 * says nothing about the constraint the code is holding. The constraint goes in the comment;
 * the id goes in the commit.
 *
 * Fixtures and tests are exempt from this scan because fixture data strings may legitimately
 * carry recorded evidence verbatim. Their comments and titles still follow the same register:
 * describe the behavior or the constraint, and keep the id in the commit that introduced it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, '..', '..');

const FINDING_ID = /\bEX-\d+\b/;

function sourceFiles(): readonly string[] {
  return globSync('*/src/**/*.ts', { cwd: PACKAGES })
    .filter((path) => !path.endsWith('.test.ts'))
    .filter((path) => !path.endsWith('.fixture.ts'))
    .map((path) => join(PACKAGES, path));
}

describe('comment discipline', () => {
  it('names no exercise finding id in production source', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === fileURLToPath(import.meta.url)) {
        continue;
      }
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (FINDING_ID.test(line)) {
          offenders.push(`${relative(PACKAGES, file)}:${String(index + 1)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('scans the whole workspace rather than one package', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(80);
    expect(files.some((file) => file.includes('/protocol/'))).toBe(true);
    expect(files.some((file) => file.includes('/cli/'))).toBe(true);
    expect(files.some((file) => file.includes('/mcp/'))).toBe(true);
  });
});
