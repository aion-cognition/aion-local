import {
  cleanupNarratives,
  DEFAULT_CLEANUP_LIMIT,
  type NarrativeCleanupReport,
} from './narrative-cleanup.js';
import type { NarrativeDeps } from './narratives.js';
import { loadConfig } from '../../infrastructure/config/load-config.js';
import { GraphConnection } from '../../infrastructure/graph/connection.js';
import { findStaleNarratives } from '../../infrastructure/graph/narrative-queries.js';
import { openLogger } from '../../infrastructure/logging/logger.js';
import { OllamaProvider } from '../../infrastructure/providers/ollama-provider.js';
import { NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * Runs `cleanupNarratives` against whatever substrate the environment points at. Compiled,
 * like the quality harness: `tsc -b packages/core && node
 * packages/core/dist/reflection/application/narrative-cleanup-run.js`. Against the compose
 * stack from the host that is `AION_NEO4J_URI=bolt://127.0.0.1:7687` with the stack's
 * password and `AION_OLLAMA_URL=http://127.0.0.1:11434`.
 */

function render(report: NarrativeCleanupReport, remaining: number): string {
  return [
    'narrative cleanup:',
    `  stale before   ${String(report.examined)}`,
    `  sessions       ${String(report.sessions)}`,
    `  regenerated    ${String(report.regenerated)}`,
    `  forgotten      ${String(report.forgotten)}`,
    `  failed         ${String(report.failed)}`,
    `  stale after    ${String(remaining)}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const connection = new GraphConnection(config.neo4j);
  const health = await connection.health();
  if (!health.reachable) {
    throw new Error(`${config.neo4j.uri} is unreachable: ${health.error ?? 'no detail'}`);
  }

  const logger = openLogger(config.logging);
  const deps: NarrativeDeps = {
    driver: connection.driver,
    provider: new OllamaProvider({
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
    }),
    logger,
  };

  try {
    const report = await cleanupNarratives(deps, {
      model: config.models.reflect,
      maxSourceEpisodes: config.reflection.maxNarrativeEpisodes,
      maxEpisodeChars: config.reflection.maxNarrativeEpisodeChars,
      timeoutMs: config.reflection.stageTimeoutMs,
    });
    const remaining = await findStaleNarratives(
      connection.driver,
      NARRATIVE_GROUNDING,
      DEFAULT_CLEANUP_LIMIT,
    );
    process.stdout.write(render(report, remaining.length));
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
