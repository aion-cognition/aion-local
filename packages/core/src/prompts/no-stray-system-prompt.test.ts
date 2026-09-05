import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One directory holds every generation system prompt, so a repo-wide scan is the cheapest place
 * to hold that line: a prompt declared beside its call site reads fine in review and drifts from
 * the text the batteries score. The scan is modelled on the hard-delete guard, and pins its own
 * skip list the same way.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const PACKAGES_DIR = join(REPO_ROOT, 'packages');
const PROMPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);
const TOOL_DESCRIPTIONS = join(PACKAGES_DIR, 'mcp', 'src', 'descriptions.ts');
const HARNESS_PROMPTS = join(
  PACKAGES_DIR,
  'core',
  'src',
  'reflection',
  'test-support',
  'quality-harness',
  'prompts.ts',
);

/**
 * The scan skips this file, which has to name the pattern it forbids, and two others. The MCP
 * descriptions are what an agent reads when it decides whether to call a tool, which is product
 * surface rather than text a model generates against. The quality harness keeps its own copies
 * of the extraction prompts, and nothing the pipeline runs reads them. The test below pins the
 * list, so a fourth entry cannot land quietly.
 */
const EXEMPT = [THIS_FILE, TOOL_DESCRIPTIONS, HARNESS_PROMPTS];

/**
 * Any identifier ending in SYSTEM_PROMPT being assigned, which is how every surface in this
 * directory named its text before it moved here. An import that aliases one of these back to its
 * old name assigns nothing and is not a declaration.
 */
const DECLARATION = /(?:^|[^A-Za-z0-9_])[A-Za-z0-9_]*SYSTEM_PROMPT\s*=/;

/** Comments quote prompt names in prose; only executable text is scanned. */
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
    } else if (
      entry.name.endsWith('.ts') &&
      !EXEMPT.includes(path) &&
      !path.startsWith(PROMPTS_DIR)
    ) {
      found.push(path);
    }
  }
  return found;
}

describe('every generation prompt lives in the prompts directory', () => {
  const files = collectSourceFiles(PACKAGES_DIR);

  it('scans every TypeScript source file in the workspace', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((file) => relative(REPO_ROOT, file).startsWith(`packages${sep}mcp`))).toBe(
      true,
    );
  });

  it('skips exactly three files: itself, the tool descriptions, and the harness copies', () => {
    expect(EXEMPT.map((file) => relative(REPO_ROOT, file))).toEqual([
      join('packages', 'core', 'src', 'prompts', 'no-stray-system-prompt.test.ts'),
      join('packages', 'mcp', 'src', 'descriptions.ts'),
      join(
        'packages',
        'core',
        'src',
        'reflection',
        'test-support',
        'quality-harness',
        'prompts.ts',
      ),
    ]);
    for (const file of EXEMPT) {
      expect(existsSync(file)).toBe(true);
      expect(files).not.toContain(file);
    }
  });

  it('leaves the prompts directory itself out of the scan', () => {
    expect(files.filter((file) => file.startsWith(PROMPTS_DIR))).toEqual([]);
  });

  it('finds no system prompt declared anywhere else', () => {
    const offenders = files
      .filter((file) => DECLARATION.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('catches a declaration whatever the identifier is prefixed with', () => {
    expect(DECLARATION.test('const SYSTEM_PROMPT = [')).toBe(true);
    expect(DECLARATION.test('const DETECT_SYSTEM_PROMPT = [')).toBe(true);
    expect(DECLARATION.test('  REVIEW_SYSTEM_PROMPT= `You review`;')).toBe(true);
  });

  it('leaves an import of a moved prompt alone', () => {
    const aliased = "import { LOCAL as SYSTEM_PROMPT } from '../../../prompts/curiosity.js';";
    expect(DECLARATION.test(aliased)).toBe(false);
    expect(DECLARATION.test("  { role: 'system', content: SYSTEM_PROMPT },")).toBe(false);
  });
});
