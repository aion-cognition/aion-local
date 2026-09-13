import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractCognitiveViaProvider, extractEntitiesViaProvider } from './provider-extractor.js';
import { renderJsonReport, renderMarkdownReport } from './report.js';
import type { SkippedRoute } from './report.js';
import { runQualityHarness, type RouteConfig } from './runner.js';
import { applyEnvDefaults } from '../../../infrastructure/config/env-file.js';
import { loadConfig } from '../../../infrastructure/config/load-config.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { AnthropicHaikuClient } from '../../../infrastructure/providers/test-support/anthropic-client.js';

/**
 * Everything this harness runs on comes from the loader: the Anthropic model and its API key.
 * The harness measures the model the service would actually route to, so it reads no env var of
 * its own and holds no default that could drift from the knob table.
 */

// This module runs compiled from `dist/`. Reports belong next to the source for easy review,
// not inside a directory `npm run clean` deletes.
const COMPILED_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = COMPILED_DIR.replace(`${sep}dist${sep}`, `${sep}src${sep}`);
const REPORTS_DIR = join(SOURCE_DIR, 'reports');

const ANTHROPIC_ROUTE = { provider: 'anthropic' } as const;

function buildAnthropicRoute(config: Config): RouteConfig {
  const { apiKey, model } = config.anthropic;
  const client = new AnthropicHaikuClient({ apiKey });
  const deps = { generate: client.generate.bind(client), model, route: ANTHROPIC_ROUTE };

  return {
    route: 'anthropic',
    model,
    extractEntities: (text) => extractEntitiesViaProvider(deps, text),
    extractCognitive: (text) => extractCognitiveViaProvider(deps, text),
  };
}

async function main(): Promise<void> {
  // Run from the repo root on the host, where nothing has loaded `.env`. Without this the key
  // is invisible and the harness has nothing to measure.
  applyEnvDefaults(join(process.cwd(), '.env'), ['AION_ANTHROPIC_API_KEY', 'AION_ANTHROPIC_MODEL']);
  const config = loadConfig(process.env);
  const routes: RouteConfig[] = [];
  const skippedRoutes: SkippedRoute[] = [];

  const { apiKey } = config.anthropic;
  if (apiKey.trim().length > 0) {
    routes.push(buildAnthropicRoute(config));
  } else {
    skippedRoutes.push({ route: 'anthropic', reason: 'AION_ANTHROPIC_API_KEY not set' });
    process.stdout.write(`AION_ANTHROPIC_API_KEY not set; there is no other route to measure.\n`);
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
