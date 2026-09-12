import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The line between a destructive capability existing and being reachable.
 *
 * No writer the compatibility audit marks unknown may be enabled while the contract is being
 * activated, and the audit still carries a large owed body: the reflection stage writers,
 * plasticity, merge and unmerge, and the introspection operations all mutate the graph outside
 * the publication protocol today. Eviction is therefore built and fenced rather than built and
 * live, and the fence is one positively verified fact: the eviction compatibility revision on
 * the publication control record.
 *
 * Exactly one production path sets that revision, and it is an audited operation an operator
 * publishes by hand. Nothing in initialization, the service start or the maintenance catalog
 * reaches it, so every substrate answers `compatibility_not_established` for every source until
 * somebody deliberately arms it. This test is what keeps that true: a second writer would arm
 * the capability silently, and the change that adds one has to change these lists and be
 * reviewed for doing so.
 *
 * Coverage activation is a different gate on the same row, because a substrate that cannot state
 * what it covers is unusable while a substrate that cannot evict is merely full. The last cases
 * hold them apart and hold the arming column's writer to one caller.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const CAPABILITY_COLUMN = 'eviction_compatibility_revision';
const COVERAGE_COLUMN = 'activation_capability_revision';
/** The two functions that reach the row, so the caller scan does not depend on SQL text. */
const ARMING_WRITER = 'establishEvictionCompatibility';
const DISARM_WRITER = 'recordEvictionDisarm';

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

  it('finds one production path that sets the eviction compatibility revision', () => {
    // The scan catches a writer in any of the four statement forms, in any file, so a second
    // entry appearing here is a second writer and this equality is what fails on it.
    const offenders = files.filter((file) => writesTheCapability(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'core', 'src', 'infrastructure', 'sqlite', 'publication-control.ts'),
    ]);
  });

  it('finds one production caller of that writer, and it is the arming acknowledgment', () => {
    const definition = join(
      PACKAGES_DIR,
      'core',
      'src',
      'infrastructure',
      'sqlite',
      'publication-control.ts',
    );
    const callers = files.filter(
      (file) => file !== definition && readFileSync(file, 'utf8').includes(`${ARMING_WRITER}(`),
    );
    expect(callers.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'core', 'src', 'reflection', 'application', 'eviction-arming.ts'),
    ]);
    // Named inside the acknowledgment and nowhere else in the module, so the write cannot happen
    // on a path that did not first pass the operation's check.
    const arming = readFileSync(callers[0] ?? '', 'utf8');
    expect(arming.split(`${ARMING_WRITER}(`)).toHaveLength(2);
    expect(arming.slice(arming.indexOf('acknowledgeSqlite')).includes(ARMING_WRITER)).toBe(true);
  });

  it('finds one production caller of the stop, and it is the same acknowledgment', () => {
    const definition = join(
      PACKAGES_DIR,
      'core',
      'src',
      'infrastructure',
      'sqlite',
      'publication-control.ts',
    );
    const callers = files.filter(
      (file) => file !== definition && readFileSync(file, 'utf8').includes(`${DISARM_WRITER}(`),
    );
    expect(callers.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'core', 'src', 'reflection', 'application', 'eviction-arming.ts'),
    ]);
  });

  it('finds neither act called from initialization, the service or the maintenance catalog', () => {
    // Both acts are an operator's. A caller here would make one a side effect of starting up.
    const forbidden = ['cli/src/init.ts', 'mcp/src/bootstrap.ts', 'introspection/application'];
    const reached = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return (
        forbidden.some((part) => relative(REPO_ROOT, file).includes(join(...part.split('/')))) &&
        (source.includes(ARMING_WRITER) || source.includes(DISARM_WRITER))
      );
    });
    expect(reached.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it('still finds the stop read before the revision, which is what makes it fail-closed', () => {
    const fence = join(
      PACKAGES_DIR,
      'core',
      'src',
      'reflection',
      'application',
      'eviction-eligibility.ts',
    );
    const source = readFileSync(fence, 'utf8');
    expect(source.indexOf('evictionDisarmedAt !== null')).toBeGreaterThan(0);
    expect(source.indexOf('evictionDisarmedAt !== null')).toBeLessThan(
      source.indexOf('evictionCompatibilityRevision <= 0'),
    );
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
