import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The line between a destructive capability existing and being reachable.
 *
 * C9 §2 is explicit that no writer the audit marks unknown may be enabled during M2 activation,
 * and the audit still carries a large owed body: the reflection stage writers, plasticity, merge
 * and unmerge, forget and unsupersede, and the introspection operations all mutate the graph
 * outside the publication protocol today. Eviction is therefore built and fenced rather than
 * built and live, and the fence is one positively verified fact: the capability revision on the
 * publication control record.
 *
 * Nothing in production sets that revision. The compatibility audit owns it, and no audit has
 * run, so `durableEligibility` answers `compatibility_not_established` for every source on every
 * deployed substrate and the operation removes nothing. This test is what keeps that true: a
 * writer that set the revision would quietly arm every destructive path behind it, and the
 * change that adds one has to change this list and be reviewed for doing so.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const CAPABILITY_COLUMN = 'activation_capability_revision';

/**
 * A write is an UPDATE or an INSERT reaching this column; a read of it is not one.
 *
 * The scan windows on the table name rather than matching up to a delimiter, because the
 * statements in this repo are template literals spanning several lines and a delimiter-bounded
 * pattern stops at the first backtick or quote it meets. Everything inside the window counts,
 * whatever it is made of.
 */
const WINDOW = 600;
const MUTATIONS = [/UPDATE\s+publication_control/gi, /INSERT\s+INTO\s+publication_control/gi];

function writesTheCapability(source: string): boolean {
  for (const pattern of MUTATIONS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      if (source.slice(match.index, match.index + WINDOW).includes(CAPABILITY_COLUMN)) {
        return true;
      }
      match = pattern.exec(source);
    }
  }
  return false;
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

describe('the compatibility capability is not armed by any production writer', () => {
  const files = productionFiles(PACKAGES_DIR);

  it('scans every production TypeScript source under packages', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.every((file) => file.endsWith('.ts'))).toBe(true);
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

  it('finds no production path that sets the activation capability revision', () => {
    const offenders = files.filter((file) => writesTheCapability(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it('still finds the reader the coverage activation fences on', () => {
    const handler = join(
      PACKAGES_DIR,
      'core',
      'src',
      'infrastructure',
      'publication',
      'handlers.ts',
    );
    expect(readFileSync(handler, 'utf8')).toContain(CAPABILITY_COLUMN);
  });
});
