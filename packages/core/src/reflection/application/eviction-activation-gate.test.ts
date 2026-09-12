import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The line between a destructive capability existing and being reachable.
 *
 * The fence is one positively verified fact: the eviction compatibility revision on the
 * publication control record. Exactly one production path sets that revision, through one audited
 * operation, and as of 2026-09-12 the caller of that operation is the service start rather than an
 * operator's command — the manual arming step was removed. What that changes is who publishes it;
 * what it does not change is that a substrate answers `compatibility_not_established` for every
 * source until the operation's own preconditions pass, that the operation is the only way through,
 * and that the writer behind it has one caller.
 *
 * So the pins move rather than relax. The arm act is published from exactly one place and this
 * test names it, initialization and the maintenance catalog still reach neither act, the stop and
 * its claim stay an operator's, and the CLI no longer carries an arm at all. A second publisher, a
 * second writer, or an arm reappearing in the catalog is a change to these lists, and the change
 * that makes one has to be reviewed for it.
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
const CLAIM_WRITER = 'claimEvictionStop';
/** The one path that arms a substrate on its own, now that no command does it first. */
const START_ARM = 'armEvictionOnStart';
/** The operation both arming paths and the stop go through. */
const ARMING_KIND = 'evictionArmingPublication';

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

  it('finds no writer of the row called from initialization, the service or the catalog', () => {
    // The service start publishes the arm act; it does not write the row. The row's writers stay
    // inside the operation's own acknowledgment on every path, which is what keeps the receipt
    // ahead of the permission. The claim is on the list because taking it stops eviction on its
    // own, and initialization and the catalog reach nothing here at all.
    const forbidden = ['cli/src/init.ts', 'mcp/src/bootstrap.ts', 'introspection/application'];
    const writers = [ARMING_WRITER, DISARM_WRITER, CLAIM_WRITER, 'releaseEvictionStopClaim'];
    const reached = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return (
        forbidden.some((part) => relative(REPO_ROOT, file).includes(join(...part.split('/')))) &&
        writers.some((writer) => source.includes(writer))
      );
    });
    expect(reached.map((file) => relative(REPO_ROOT, file))).toEqual([]);
  });

  it('finds the start arm published from one place, and it is the service start', () => {
    // `armEvictionOnStart` is the whole automatic arming path, so the set of files that call it is
    // the set of things that can arm a substrate on their own. One entry, and it is the boot
    // sequence.
    const definition = join(
      PACKAGES_DIR,
      'core',
      'src',
      'reflection',
      'application',
      'eviction-arming-start.ts',
    );
    const callers = files.filter(
      (file) => file !== definition && readFileSync(file, 'utf8').includes(`${START_ARM}(`),
    );
    expect(callers.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'mcp', 'src', 'bootstrap.ts'),
    ]);
  });

  it('finds the arming operation published from exactly two places, and names both', () => {
    // The service start, and the command an operator takes a stop back with: a stop must not be a
    // one-way door. These two files are the whole set that publishes this operation, and a third
    // appearing here is a third way to move a destructive capability.
    const publishers = files.filter((file) =>
      readFileSync(file, 'utf8').includes(`${ARMING_KIND}.kind`),
    );
    expect(publishers.map((file) => relative(REPO_ROOT, file)).sort()).toEqual([
      join('packages', 'cli', 'src', 'evict.ts'),
      join('packages', 'core', 'src', 'reflection', 'application', 'eviction-arming-start.ts'),
    ]);
  });

  it('finds the start arm refusing to publish over a stop, before it reads the revision', () => {
    const start = readFileSync(
      join(PACKAGES_DIR, 'core', 'src', 'reflection', 'application', 'eviction-arming-start.ts'),
      'utf8',
    );
    // A restart is not a retraction of a disarm. The stop resolves through the same shared reader
    // the fence uses, and it is asked before the revision, so a disarmed substrate that restarts
    // stays disarmed rather than being re-armed as if it had never been stopped.
    expect(start.indexOf('evictionStopStands(db, pairing)')).toBeGreaterThan(0);
    expect(start.indexOf('evictionStopStands(db, pairing)')).toBeLessThan(
      start.indexOf('evictionCompatibilityRevision >='),
    );
  });

  it('finds the CLI publishing its own subcommand as the act, and `arm` is not one', () => {
    // The act the command publishes is the word the operator typed, so the subcommand list is the
    // act set. `arm` is not in it: the first arming is the substrate's, and what a person can do
    // is stop the fence or take that stop back. The ledger reads the difference.
    const evict = readFileSync(join(PACKAGES_DIR, 'cli', 'src', 'evict.ts'), 'utf8');
    expect(evict).toContain("subcommands: ['status', 'disarm', 'rearm']");
    expect(evict).toContain('act: action');
    expect(evict).not.toContain("act: 'arm'");
    expect(evict).not.toContain("'arm',");
  });

  it('keeps the owed-stop refusal on the automatic path and lifts it only for the re-arm', () => {
    // The one precondition the two tables differ on, and the difference is the whole point: the
    // start must never clear a stop nobody finished recording, and an operator saying so is when
    // clearing it is right.
    const arming = readFileSync(
      join(PACKAGES_DIR, 'core', 'src', 'reflection', 'application', 'eviction-arming.ts'),
      'utf8',
    );
    expect(arming).toContain("reason: 'eviction_stop_owed'");
    expect(arming).toContain("precondition.reason !== 'eviction_stop_owed'");
    // And the filter is the only difference: the re-arm table is the arming table minus that row.
    expect(arming).toContain('armingPreconditions(db, installedKinds, revision).filter');
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
    // The stop resolves through one shared reader; what this pins is that the fence asks it, and
    // asks it before it looks at the number.
    expect(source.indexOf('evictionStopStands(db, pairing)')).toBeGreaterThan(0);
    expect(source.indexOf('evictionStopStands(db, pairing)')).toBeLessThan(
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

/**
 * The stop column carries the same one-writer pin as the fence it stops, and for a stronger
 * reason: clearing the stamp re-arms a substrate somebody deliberately closed, which is the
 * dangerous direction. Two writers are legitimate and both are named.
 */
describe('the stop on the same row has one writer set and no other', () => {
  const files = productionFiles(PACKAGES_DIR);
  const STOP_COLUMN = 'eviction_disarmed_at';
  const CLAIM_COLUMN = 'eviction_stop_requested_by';

  it('finds the stop written from one file, which holds both legitimate writers', () => {
    // `recordEvictionDisarm` stamps it; `establishEvictionCompatibility` clears it in the same
    // transaction that raises the revision, because arming is what reverses a stop.
    const offenders = files.filter((file) => writesColumn(readFileSync(file, 'utf8'), STOP_COLUMN));
    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'core', 'src', 'infrastructure', 'sqlite', 'publication-control.ts'),
    ]);
  });

  it('finds the claim written from the same one file and nowhere else', () => {
    const offenders = files.filter((file) =>
      writesColumn(readFileSync(file, 'utf8'), CLAIM_COLUMN),
    );
    expect(offenders.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'core', 'src', 'infrastructure', 'sqlite', 'publication-control.ts'),
    ]);
  });

  it('keeps every statement touching the stop inside the three functions that own it', () => {
    const control = readFileSync(
      join(PACKAGES_DIR, 'core', 'src', 'infrastructure', 'sqlite', 'publication-control.ts'),
      'utf8',
    );
    // A count would be brittle and would not say what matters. What matters is that no statement
    // reaching either column sits outside a named writer, where a reader would not look for it.
    const owners = [
      'export function establishEvictionCompatibility',
      'export function recordEvictionDisarm',
      'export function claimEvictionStop',
      'export function releaseEvictionStopClaim',
    ].map((signature) => {
      const from = control.indexOf(signature);
      expect(from).toBeGreaterThan(0);
      const next = control.indexOf('\nexport ', from + signature.length);
      return { from, to: next === -1 ? control.length : next };
    });

    const stray: string[] = [];
    for (const match of control.matchAll(/UPDATE\s+publication_control/gi)) {
      const window = control.slice(match.index, match.index + WINDOW);
      if (!window.includes(STOP_COLUMN) && !window.includes(CLAIM_COLUMN)) {
        continue;
      }
      if (!owners.some((span) => match.index >= span.from && match.index < span.to)) {
        stray.push(window.split('\n')[1] ?? window.slice(0, 60));
      }
    }
    expect(stray).toEqual([]);
  });

  it('catches a rogue clear of the stop wherever it is written', () => {
    const rogue = [
      'db.prepare(`UPDATE publication_control',
      `  SET ${STOP_COLUMN} = NULL`,
      '`);',
    ].join('\n');
    expect(writesColumn(rogue, STOP_COLUMN)).toBe(true);
    expect(writesColumn(`SELECT ${STOP_COLUMN} FROM publication_control`, STOP_COLUMN)).toBe(false);
  });

  it('finds one production caller of each act, and both are the arming operation', () => {
    const definition = join(
      PACKAGES_DIR,
      'core',
      'src',
      'infrastructure',
      'sqlite',
      'publication-control.ts',
    );
    const arming = join(
      'packages',
      'core',
      'src',
      'reflection',
      'application',
      'eviction-arming.ts',
    );
    for (const writer of [DISARM_WRITER, CLAIM_WRITER, 'releaseEvictionStopClaim']) {
      const callers = files.filter(
        (file) => file !== definition && readFileSync(file, 'utf8').includes(`${writer}(`),
      );
      expect.soft(callers.map((file) => relative(REPO_ROOT, file))).toEqual([arming]);
    }
  });
});
