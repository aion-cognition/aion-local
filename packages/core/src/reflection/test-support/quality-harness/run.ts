import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OllamaProvider } from '../../../infrastructure/providers/ollama-provider.js';
import { AnthropicHaikuClient } from './anthropic-client.js';
import { extractCognitiveViaProvider, extractEntitiesViaProvider } from './provider-extractor.js';
import { renderJsonReport, renderMarkdownReport } from './report.js';
import { runQualityHarness, type RouteConfig } from './runner.js';
import type { SkippedRoute } from './report.js';

/** Matches `config.models.reflect` / `config.models.embed` in `infrastructure/config/defaults.ts`. */
const DEFAULT_LOCAL_MODEL = 'qwen3:8b';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5';

// This module runs compiled, from `dist/`; reports belong next to the source that reads
// back easily in review, not inside a directory `npm run clean` deletes.
const COMPILED_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = COMPILED_DIR.replace(`${sep}dist${sep}`, `${sep}src${sep}`);
const REPORTS_DIR = join(SOURCE_DIR, 'reports');

function buildLocalRoute(): RouteConfig {
  const baseUrl = process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434';
  const model = process.env.AION_REFLECT_MODEL ?? DEFAULT_LOCAL_MODEL;
  const provider = new OllamaProvider({ baseUrl, embedModel: DEFAULT_EMBED_MODEL });

  return {
    route: 'local',
    model,
    extractEntities: (text) => extractEntitiesViaProvider({ generate: provider.generate.bind(provider), model }, text),
    extractCognitive: (text) => extractCognitiveViaProvider({ generate: provider.generate.bind(provider), model }, text),
  };
}

function buildAnthropicRoute(apiKey: string): RouteConfig {
  const model = process.env.AION_ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const client = new AnthropicHaikuClient({ apiKey });

  return {
    route: 'anthropic',
    model,
    extractEntities: (text) => extractEntitiesViaProvider({ generate: client.generate.bind(client), model }, text),
    extractCognitive: (text) => extractCognitiveViaProvider({ generate: client.generate.bind(client), model }, text),
  };
}

async function main(): Promise<void> {
  const routes: RouteConfig[] = [buildLocalRoute()];
  const skippedRoutes: SkippedRoute[] = [];

  const apiKey = process.env.AION_ANTHROPIC_API_KEY;
  if (apiKey !== undefined && apiKey.trim().length > 0) {
    routes.push(buildAnthropicRoute(apiKey));
  } else {
    skippedRoutes.push({ route: 'anthropic', reason: 'AION_ANTHROPIC_API_KEY not set' });
    process.stdout.write('AION_ANTHROPIC_API_KEY not set; skipping the claude-haiku-4-5 route.\n');
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
