import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `index.ts` says every export is re-exported from the layer that owns it, which makes the
 * layer barrels the package's declared surface. A symbol nothing outside core mentions is not
 * part of a surface, so the scan fails and names it.
 *
 * Dropping a symbol from a barrel takes nothing away. Core reaches its own modules by relative
 * path and never imports `@aion/core`, and `package.json` publishes `./*`, so every module is
 * still importable by subpath. The barrel is the curated list, not the only door.
 *
 * The scan matches identifier tokens instead of resolving imports, so a name appearing anywhere
 * in the consumer trees counts as consumed, comments and unrelated locals included. It errs
 * toward keeping a symbol; what it catches is the export nothing outside core says at all.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CORE_SRC = join(REPO_ROOT, 'packages', 'core', 'src');

/** Every workspace package that can import `@aion/core`. Core itself is excluded by the rule. */
const CONSUMER_PACKAGES = ['cli', 'mcp', 'protocol'];

/** Prose names symbols the code does not export, and an export name is code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The layers the entrypoint fans out to, read from it so a new layer joins the scan on its own. */
function layerNames(): readonly string[] {
  const source = stripComments(readFileSync(join(CORE_SRC, 'index.ts'), 'utf8'));
  return [...source.matchAll(/export\s+\*\s+from\s+'\.\/([\w-]+)\/index\.js'/g)].map(
    (match) => match[1]!,
  );
}

type Barrel = {
  readonly layer: string;
  readonly names: readonly string[];
  /** `export` keywords the parser turned into no names, so a new export form cannot pass unseen. */
  readonly unparsed: number;
};

const RE_EXPORT = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'[^']+'/g;

function readBarrel(layer: string): Barrel {
  const source = stripComments(readFileSync(join(CORE_SRC, layer, 'index.ts'), 'utf8'));
  const names: string[] = [];
  let statements = 0;
  for (const match of source.matchAll(RE_EXPORT)) {
    statements += 1;
    for (const clause of match[1]!.split(',')) {
      const specifier = clause.trim().replace(/^type\s+/, '');
      if (specifier.length === 0) {
        continue;
      }
      const parts = specifier.split(/\s+as\s+/);
      names.push((parts[1] ?? parts[0]!).trim());
    }
  }
  const keywords = source.match(/\bexport\b/g)?.length ?? 0;
  return { layer, names, unparsed: keywords - statements };
}

function sourceFiles(dir: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') {
        found.push(...sourceFiles(path));
      }
    } else if (entry.name.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

function consumerTokens(): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const pkg of CONSUMER_PACKAGES) {
    for (const file of sourceFiles(join(REPO_ROOT, 'packages', pkg, 'src'))) {
      for (const token of readFileSync(file, 'utf8').match(/[A-Za-z_$][\w$]*/g) ?? []) {
        tokens.add(token);
      }
    }
  }
  return tokens;
}

function orphansIn(names: readonly string[], tokens: ReadonlySet<string>): readonly string[] {
  return names.filter((name) => !tokens.has(name));
}

describe('every layer barrel symbol has a consumer outside core', () => {
  const barrels = layerNames().map(readBarrel);
  const tokens = consumerTokens();

  it('reads a barrel for every layer the entrypoint fans out to', () => {
    expect(barrels.map((barrel) => barrel.layer)).toEqual([
      'infrastructure',
      'introspection',
      'plasticity',
      'recall',
      'redaction',
      'reflection',
      'session',
    ]);
    for (const barrel of barrels) {
      expect(barrel.names.length).toBeGreaterThan(0);
    }
  });

  it('turns every export statement in every barrel into names', () => {
    expect(barrels.filter((barrel) => barrel.unparsed !== 0)).toEqual([]);
  });

  it('reads the consumer trees rather than an empty set', () => {
    expect(tokens.size).toBeGreaterThan(1000);
    expect(tokens.has('handleRecall')).toBe(true);
    expect(tokens.has('ReflectionOrchestrator')).toBe(true);
  });

  it('names an export the consumer trees never mention', () => {
    expect(orphansIn(['handleRecall', 'aSymbolNothingOutsideCoreImports'], tokens)).toEqual([
      'aSymbolNothingOutsideCoreImports',
    ]);
  });

  it('reads a renamed and an inline-type specifier as the name the barrel publishes', () => {
    const clauses = "export { readAll as readEverything, type Handle } from './x.js';";
    const names: string[] = [];
    for (const match of clauses.matchAll(RE_EXPORT)) {
      for (const clause of match[1]!.split(',')) {
        const specifier = clause.trim().replace(/^type\s+/, '');
        const parts = specifier.split(/\s+as\s+/);
        names.push((parts[1] ?? parts[0]!).trim());
      }
    }
    expect(names).toEqual(['readEverything', 'Handle']);
  });

  it('finds no barrel symbol without a consumer', () => {
    const orphans = barrels.flatMap((barrel) =>
      orphansIn(barrel.names, tokens).map((name) => `${barrel.layer}/index.ts: ${name}`),
    );
    expect(orphans).toEqual([]);
  });
});
