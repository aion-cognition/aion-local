import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The line between a destructive capability existing and being reachable.
 *
 * No writer the compatibility audit marks unknown may be enabled while the contract is being
 * activated, and the audit still carries a large owed body: the reflection stage writers, plasticity, merge
 * and unmerge, forget and unsupersede, and the introspection operations all mutate the graph
 * outside the publication protocol today. Eviction is therefore built and fenced rather than
 * built and live, and the fence is one positively verified fact: the eviction compatibility
 * revision on the publication control record.
 *
 * Nothing in production sets that revision. The compatibility audit owns it, and no audit has
 * run, so `durableEligibility` answers `compatibility_not_established` for every source on every
 * deployed substrate and the operation removes nothing. This test is what keeps that true: a
 * writer that set the revision would quietly arm every destructive path behind it, and the
 * change that adds one has to change this list and be reviewed for doing so.
 *
 * Coverage activation is a different gate on the same row and has its own producer, because a
 * substrate that cannot state what it covers is unusable while a substrate that cannot evict is
 * merely full. The last two cases hold the two apart: the arming column has no production
 * writer, and the coverage column does.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const CAPABILITY_COLUMN = 'eviction_compatibility_revision';
const COVERAGE_COLUMN = 'activation_capability_revision';

/**
 * A write is an UPDATE, an INSERT or a REPLACE reaching this column; a read of it is not one.
 *
 * The scan windows on the table name rather than matching up to a delimiter, because the
 * statements in this repo are template literals spanning several lines and a delimiter-bounded
 * pattern stops at the first backtick or quote it meets. Everything inside the window counts,
 * whatever it is made of.
 *
 * The REPLACE pattern covers both spellings SQLite accepts, the bare `REPLACE INTO` and the
 * `INSERT OR REPLACE INTO` whose tail it matches. Neither is used anywhere in this repo today,
 * and the point of naming them is that a writer added in either form is caught by the scan
 * rather than by somebody noticing.
 *
 * What the scan cannot see is a statement whose column name is not in the source: a name built
 * from a variable, or a whole statement assembled at runtime, passes it. Closing that needs a
 * different instrument than a text scan, and the residual is recorded against the arming
 * decision rather than papered over here.
 */
const WINDOW = 600;
const MUTATIONS = [
  /UPDATE\s+publication_control/gi,
  /INSERT\s+INTO\s+publication_control/gi,
  /REPLACE\s+INTO\s+publication_control/gi,
];

function writesColumn(source: string, column: string): boolean {
  for (const pattern of MUTATIONS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      if (source.slice(match.index, match.index + WINDOW).includes(column)) {
        return true;
      }
      match = pattern.exec(source);
    }
  }
  return false;
}

function writesTheCapability(source: string): boolean {
  return writesColumn(source, CAPABILITY_COLUMN);
}

function productionFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', 'test-support'].includes(entry.name)) {
        found.push(...productionFiles(path));
      }
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.fixture.ts')
    ) {
      found.push(path);
    }
  }
  return found;
}

describe('the eviction compatibility capability is not armed by any production writer', () => {
  const files = productionFiles(PACKAGES_DIR);

  it('scans every production TypeScript source under packages', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.every((file) => file.endsWith('.ts'))).toBe(true);
  });

  it('catches every statement form a writer could take', () => {
    const reaching = (statement: string): string =>
      [`db.prepare(\`${statement}`, `  SET ${CAPABILITY_COLUMN} = 1`, '`);'].join('\n');

    expect(writesTheCapability(reaching('UPDATE publication_control'))).toBe(true);
    expect(writesTheCapability(reaching('INSERT INTO publication_control'))).toBe(true);
    expect(writesTheCapability(reaching('REPLACE INTO publication_control'))).toBe(true);
    expect(writesTheCapability(reaching('INSERT OR REPLACE INTO publication_control'))).toBe(true);
  });

  it('catches a multi-line template-literal write, which the statements here are', () => {
    expect(
      writesTheCapability(
        ['db.prepare(`UPDATE publication_control', `  SET ${CAPABILITY_COLUMN} = 1`, '`);'].join(
          '\n',
        ),
      ),
    ).toBe(true);
    expect(writesTheCapability(`SELECT ${CAPABILITY_COLUMN} FROM publication_control`)).toBe(false);
  });

  it('finds no production path that sets the eviction compatibility revision', () => {
    const offenders = files.filter((file) => writesTheCapability(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it('still finds the column read and the fence that acts on what it says', () => {
    const control = join(
      PACKAGES_DIR,
      'core',
      'src',
      'infrastructure',
      'sqlite',
      'publication-control.ts',
    );
    const fence = join(
      PACKAGES_DIR,
      'core',
      'src',
      'reflection',
      'application',
      'eviction-eligibility.ts',
    );
    expect(readFileSync(control, 'utf8')).toContain(CAPABILITY_COLUMN);
    expect(readFileSync(fence, 'utf8')).toContain('evictionCompatibilityRevision <= 0');
  });

  it('finds one production writer of the coverage column, which is the gate the fence is not', () => {
    const producers = files.filter((file) =>
      writesColumn(readFileSync(file, 'utf8'), COVERAGE_COLUMN),
    );
    expect(producers.map((file) => relative(REPO_ROOT, file))).toEqual([
      'packages/core/src/infrastructure/sqlite/publication-control.ts',
    ]);
  });
});
