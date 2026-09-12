import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No source file may contain a raw NUL byte, because git and grep both stop reading it.
 *
 * A single `\0` written as a literal character instead of the escape turns a TypeScript file
 * into a binary blob as far as every tool that reads the repository is concerned: `git diff`
 * reports `Bin 0 -> N bytes` with no hunks, `git grep` answers "Binary file ... matches" with no
 * lines, and plain `grep --include='*.ts'` skips the file and exits 0 with no output. The file
 * still compiles and its tests still pass, so nothing else catches it.
 *
 * That combination is worse than a broken build. A reviewer diffing the change sees nothing, and
 * an audit-by-grep — "which files write this property", "is there a fourth writer" — gets a
 * clean answer that silently excludes the one file it most needed to read. It has happened twice
 * in this repository now, in `overview-coverage.ts` and then in `context-vector-sync.ts`, and
 * both times the file was the subject of the review it hid from. A one-file scan ends the class.
 *
 * The scan covers every `.ts` file under `packages/`, tests and fixtures included: a fixture that
 * cannot be grepped hides just as much as a module that cannot.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      found.push(...collectSourceFiles(path));
      continue;
    }
    if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

describe('the repository holds no source file git and grep read as binary', () => {
  it('finds no raw NUL byte in any TypeScript file under packages/', () => {
    const offenders: string[] = [];
    const files = collectSourceFiles(PACKAGES_DIR);

    for (const file of files) {
      const bytes = readFileSync(file);
      const at = bytes.indexOf(0);
      if (at !== -1) {
        offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')} (byte ${String(at)})`);
      }
    }

    // Named rather than counted: the fix is one character per site and the reader needs the site.
    expect(offenders).toEqual([]);
    // The scan has to have looked at something; an empty walk would pass vacuously for ever.
    expect(files.length).toBeGreaterThan(500);
  });
});
