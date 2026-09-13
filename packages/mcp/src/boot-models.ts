import {
  reconcileResidentModels,
  type Config,
  type Embedder,
  type Logger,
  type ReconciliationReport,
} from '@aion/core';

/**
 * The two model steps a boot takes before it binds a port, kept apart from the composition that
 * orders them. Both fail open: the service never depends on either having happened.
 */

/**
 * Boot's half of model reconciliation: it reads whether the embedding model is already in
 * memory, which is the difference between a first recall that waits for a model load and one
 * that does not. Nothing is unloaded, because the embedder is the only model this program asks
 * Ollama for and it is the vector index. `aion init` runs the other half. Failures are logged
 * and nothing else: the service does not depend on this.
 */
export async function reconcileModels(
  config: Config,
  logger: Logger,
): Promise<ReconciliationReport | undefined> {
  try {
    const report = await reconcileResidentModels({
      baseUrl: config.ollama.url,
      embedModel: config.models.embed,
    });
    logger.info({ reconciliation: report }, `model reconciliation: ${report.detail}`);
    return report;
  } catch (err) {
    logger.warn({ err }, 'model reconciliation failed');
    return undefined;
  }
}

/**
 * One probe embed at boot, so a cold Ollama pays its model load here rather than inside the
 * first recall, whose callers sit in synchronous harness hooks with a 10s budget. The logged
 * duration is the cold/warm tell: seconds is a load, milliseconds is a model already resident.
 * Fail-open like reconciliation: the service never depends on the warm having happened.
 */
export async function warmEmbedModel(embedder: Embedder, logger: Logger): Promise<void> {
  const started = Date.now();
  try {
    await embedder.embed(['embed warm-up probe']);
    logger.info({ ms: Date.now() - started }, 'embed model warmed');
  } catch (err) {
    logger.warn({ err, ms: Date.now() - started }, 'embed warm-up failed');
  }
}
