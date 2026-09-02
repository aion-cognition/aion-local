import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractCognitiveViaProvider, extractEntitiesViaProvider } from './provider-extractor.js';
import { renderJsonReport, renderMarkdownReport } from './report.js';
import type { SkippedRoute } from './report.js';
import { runQualityHarness, type RouteConfig } from './runner.js';
import { loadConfig } from '../../../infrastructure/config/load-config.js';
import type { Config } from '../../../infrastructure/config/schema.js';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import { AnthropicHaikuClient } from '../../../infrastructure/providers/test-support/anthropic-client.js';

/**
 * Everything this harness runs on comes from the loader: the Ollama URL, the reflect model,
 * the embed model, the Anthropic model and its API key. The harness measures the models the
 * service would actually route to, so it reads no env var of its own and holds no default
 * that could drift from the knob table.
 */

// This module runs compiled from `dist/`. Reports belong next to the source for easy review,
// not inside a directory `npm run clean` deletes.
const COMPILED_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = COMPILED_DIR.replace(`${sep}dist${sep}`, `${sep}src${sep}`);
const REPORTS_DIR = join(SOURCE_DIR, 'reports');

function buildLocalRoute(config: Config): RouteConfig {
  const model = config.models.reflect;
  const provider = new OllamaProvider({
    baseUrl: config.ollama.url,
    embedModel: config.models.embed,
  });

  return {
    route: 'local',
    model,
    extractEntities: (text) =>
      extractEntitiesViaProvider({ generate: provider.generate.bind(provider), model }, text),
    extractCognitive: (text) =>
      extractCognitiveViaProvider({ generate: provider.generate.bind(provider), model }, text),
  };
}

function buildAnthropicRoute(config: Config): RouteConfig {
  const { apiKey, model } = config.anthropic;
  const client = new AnthropicHaikuClient({ apiKey });

  return {
    route: 'anthropic',
    model,
    extractEntities: (text) =>
      extractEntitiesViaProvider({ generate: client.generate.bind(client), model }, text),
    extractCognitive: (text) =>
      extractCognitiveViaProvider({ generate: client.generate.bind(client), model }, text),
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const routes: RouteConfig[] = [buildLocalRoute(config)];
  const skippedRoutes: SkippedRoute[] = [];

  const { apiKey } = config.anthropic;
  if (apiKey.trim().length > 0) {
    routes.push(buildAnthropicRoute(config));
  } else {
    skippedRoutes.push({ route: 'anthropic', reason: 'AION_ANTHROPIC_API_KEY not set' });
    process.stdout.write(
      `AION_ANTHROPIC_API_KEY not set; skipping the ${config.anthropic.model} route.\n`,
    );
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
