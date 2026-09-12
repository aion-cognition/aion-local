import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { reflectionStages } from './pipeline.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';

/**
 * Every production composition of the reflection pipeline hands it a publication coordinator.
 *
 * Two stages in the shipped list write through the protocol and nowhere else — narration and the
 * context-vector recomputation — and both fail closed without one. A composition that omits it
 * therefore does not crash, does not log at any level a test asserts on, and does not fail a
 * suite: it runs the pipeline with its last two stages refusing on every single episode. That is
 * how `aion replay` shipped for as long as it did, and the break was found by reading the
 * composition rather than by anything going red.
 *
 * So the guard is structural and lives here rather than in any one command's battery. A scan
 * cannot be satisfied by a command nobody exercises, and it covers the next composition as well
 * as the three that exist.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
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
    // Production only. A unit root composing an orchestrator over two hand-picked stages is
    // asserting something about those stages, not shipping a pipeline to anybody.
    if (
      entry.name.endsWith('.ts') &&
      !entry.name.includes('.test.') &&
      !path.includes('test-support')
    ) {
      found.push(path);
    }
  }
  return found;
}

/** The argument list of one `new ReflectionOrchestrator(...)`, balanced to its closing paren. */
function constructionAt(source: string, from: number): string {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(from, index + 1);
      }
    }
  }
  return source.slice(from);
}

describe('the production reflection pipeline', () => {
  it('carries two stages that cannot write without the publication guard', () => {
    const stages = reflectionStages(DEFAULTS).map((stage) => stage.name);

    // Named so the scan below has a stated reason rather than a historical one. A third such
    // stage joining the list needs no change here; the scan already covers it.
    expect(stages).toContain('narratives');
    expect(stages).toContain('context-vectors');
  });

  it('is never constructed in production without a coordinator', () => {
    const offenders: string[] = [];
    let constructions = 0;

    for (const file of collectSourceFiles(PACKAGES_DIR)) {
      const source = readFileSync(file, 'utf8');
      let at = source.indexOf('new ReflectionOrchestrator');
      while (at !== -1) {
        constructions += 1;
        const call = constructionAt(source, source.indexOf('(', at));
        if (!call.includes('publications')) {
          const line = source.slice(0, at).split('\n').length;
          offenders.push(`${relative(REPO_ROOT, file).split(sep).join('/')}:${String(line)}`);
        }
        at = source.indexOf('new ReflectionOrchestrator', at + 1);
      }
    }

    expect(offenders).toEqual([]);
    // The scan has to have found the compositions it exists for; zero would pass vacuously.
    expect(constructions).toBeGreaterThanOrEqual(3);
  });
});
