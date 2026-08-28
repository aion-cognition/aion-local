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
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const THIS_FILE = fileURLToPath(import.meta.url);

/**
 * Cypher keywords are case-insensitive, so the scan has to be too. Two exclusions keep
 * the pattern on its subject, which is graph nodes. JavaScript's own `delete` operator
 * is always followed by a property access (`delete obj.key`, `delete map[key]`) and is a
 * syntax error without one under ESM's implicit strict mode. SQL's `DELETE FROM <table>`
 * is not Cypher at all — `FROM` is not a Cypher keyword — and a SQLite row is not a node:
 * the reflection queue row is retry durability, discarded once its job succeeds, while
 * the durable record of that job is the ops-ledger key.
 */
const FORBIDDEN = [
  { name: 'DETACH DELETE', pattern: /\bDETACH\s+DELETE\b/i },
  { name: 'DELETE clause', pattern: /\bDELETE\s+(?!FROM\b)[A-Za-z_][A-Za-z0-9_]*\s*(?![.[\w])/i },
];

/** Comments discuss deletion in prose; only executable text is scanned. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(source)) {
          offenders.push(`${relative(REPO_ROOT, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches a lowercase delete, since Cypher keywords are case-insensitive', () => {
    const lowercase = stripComments('const q = `MATCH (n:Probe) detach delete n`;\n');
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(lowercase))).toBe(true);

    const bare = stripComments("await tx.run('match (n) delete n');\n");
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(bare))).toBe(true);
  });

  it('still catches a Cypher delete that names a table-shaped variable', () => {
    const cypher = stripComments("await tx.run('MATCH (n:Session) DELETE from_node');\n");
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(cypher))).toBe(true);
  });

  it('leaves a SQL row delete alone, since a queue row is not a node', () => {
    const sql = stripComments("db.prepare('DELETE FROM reflection_queue WHERE id = ?');\n");
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(sql))).toBe(false);
  });

  it('leaves the JavaScript delete operator and prose about deletion alone', () => {
    const operator = stripComments("delete process.env['AION_LOG_FILE'];\ndelete cache[key];\n");
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(operator))).toBe(false);

    const prose = stripComments('// never delete a node; supersession closes it instead\nconst x = 1;\n');
    expect(FORBIDDEN.some(({ pattern }) => pattern.test(prose))).toBe(false);
  });
});
