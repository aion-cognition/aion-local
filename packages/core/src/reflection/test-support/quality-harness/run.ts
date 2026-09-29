import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfiguredExtractionRoute } from './configured-route.js';
import { renderJsonReport, renderMarkdownReport } from './report.js';
import type { SkippedRoute } from './report.js';
import { runQualityHarness, type RouteConfig } from './runner.js';
import { applyEnvDefaults } from '../../../infrastructure/config/env-file.js';
import { loadConfig } from '../../../infrastructure/config/load-config.js';
import { knownEnvVars } from '../../../infrastructure/config/registry.js';
import { unavailableReason } from '../../../infrastructure/providers/routing.js';

/**
 * Provider choice and request settings come from the service's configuration and router.
 * The report records extraction outcomes without imposing a model-quality gate.
 */

// This module runs compiled from `dist/`. Reports belong next to the source for easy review,
// not inside a directory `npm run clean` deletes.
const COMPILED_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = COMPILED_DIR.replace(`${sep}dist${sep}`, `${sep}src${sep}`);
const REPORTS_DIR = join(SOURCE_DIR, 'reports');

async function main(): Promise<void> {
  // Run from the repo root on the host, where nothing has loaded `.env`. Without this the key
  // is invisible and the harness has nothing to measure.
  applyEnvDefaults(join(process.cwd(), '.env'), [...knownEnvVars()]);
  const config = loadConfig(process.env);
  const selected = new ConfiguredExtractionRoute({ config });
  const routes: RouteConfig[] = [];
  const skippedRoutes: SkippedRoute[] = [];

  if (selected.available) {
    routes.push(selected);
  } else {
    const reason = unavailableReason({ provider: selected.route });
    skippedRoutes.push({ route: selected.route, reason });
    process.stdout.write(`${reason}; the selected route will be skipped.\n`);
  }

  process.stdout.write(`Running extraction quality harness against ${routes.length} route(s)...\n`);
  const report = await runQualityHarness({ routes, skippedRoutes });

  mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const markdownPath = join(REPORTS_DIR, `${stamp}.md`);
  const jsonPath = join(REPORTS_DIR, `${stamp}.json`);
  writeFileSync(markdownPath, renderMarkdownReport(report));
  writeFileSync(jsonPath, renderJsonReport(report));

  process.stdout.write(`Report written to ${markdownPath}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
