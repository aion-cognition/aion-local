const MACOS_INSTALL = 'brew install ollama && brew services start ollama';
const LINUX_INSTALL = 'curl -fsSL https://ollama.com/install.sh | sh';

/**
 * How much of a provider's HTTP error body an error message keeps.
 *
 * A provider error message reaches the JSONL log through every `{ err }` call site, and it is
 * also what the reflection queue stores in `last_error`. Reflection prompts embed episode and
 * claim text, so a provider that echoes the request back in its error body would write that
 * content to disk verbatim. Two hundred characters is enough to read the provider's own error
 * type and code, which is all a reader of the log needs to route the failure.
 */
export const ERROR_BODY_LIMIT = 200;

/**
 * The readable head of an HTTP error body, on one line.
 *
 * The rest is dropped on purpose: the whole body is never worth the leak, and whitespace is
 * collapsed so the message stays one line wherever it is rendered, in `last_error`, on stderr,
 * or in a log viewer.
 */
export function summarizeErrorBody(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= ERROR_BODY_LIMIT) {
    return oneLine;
  }
  return `${oneLine.slice(0, ERROR_BODY_LIMIT)} [truncated]`;
}

/**
 * Generation was asked for and has nowhere to run: the selected provider has no key, or the day's
 * ceiling is spent (below).
 *
 * It is a distinct type because the callers answer it differently from a failure: the reflection
 * worker puts the job back without spending an attempt, and recall serves its ranking unassessed
 * (the raw-query cues under the `cues` mode). The worker then narrows claiming for one breaker
 * cooldown and rechecks (`ClaimGate.holdGeneration`). A recheck spends no attempt and sends
 * nothing: while the route stays unavailable it is refused here again, before any dispatch. A
 * spent ceiling clears on the first recheck after the UTC day turns. A missing key does not,
 * because routing is resolved at boot: it takes an operator editing `.env` and rerunning
 * `aion init`, and until then the honest report is a queue that is not draining and a status
 * line that says why.
 *
 * `reason` says which: the routing layer names the selected provider's missing key, and the
 * ceiling names the day's spend. The default is for a caller that names only a surface.
 */
export class GenerationUnavailableError extends Error {
  constructor(surface: string, reason?: string) {
    super(
      reason ??
        `generation for "${surface}" has nowhere to run; the work stays queued until it does`,
    );
    this.name = 'GenerationUnavailableError';
  }
}

/**
 * The day's generation spending ceiling is reached.
 *
 * The same type as a missing key, deliberately: every caller already answers that one correctly.
 * Background work goes back on the queue without spending an attempt, recall serves its ranking
 * unassessed, and nothing throws an ordinary failure into a pipeline that would spend attempts
 * against the same exhausted ceiling. The worker's deferred recheck resumes the work on the first
 * cooldown after the UTC day turns. A higher ceiling takes effect when the service restarts.
 */
export class GenerationCeilingReachedError extends GenerationUnavailableError {
  constructor(surface: string, committedUsd: number, ceilingUsd: number) {
    super(
      surface,
      `generation for "${surface}" would pass today's ceiling of $${ceilingUsd.toFixed(2)} ` +
        `(committed $${committedUsd.toFixed(4)}); the work stays queued until the next UTC day ` +
        `or a higher AION_DAILY_CEILING_USD`,
    );
    this.name = 'GenerationCeilingReachedError';
  }
}

export function isGenerationUnavailable(err: unknown): boolean {
  return err instanceof GenerationUnavailableError;
}

/** A non-2xx answer from Ollama. `kind` names the endpoint that refused. */
export class OllamaRequestError extends Error {
  readonly status: number;

  constructor(kind: 'embed', status: number, body: string) {
    // Capped and flattened, never carried whole: this message reaches the logs through every
    // `{ err }` call site, so a body that echoes the request would leak the episode text.
    super(`Ollama ${kind} request failed: ${String(status)} ${summarizeErrorBody(body)}`);
    this.name = 'OllamaRequestError';
    this.status = status;
  }
}

/**
 * Thrown when the configured Ollama URL is unreachable. Provisioning runs inside the
 * CLI container, which cannot see the host OS, so the message lists both install
 * paths rather than picking one.
 */
export class OllamaUnreachableError extends Error {
  constructor(url: string, cause?: unknown) {
    super(
      `Ollama is not reachable at ${url}. Install it on the host, then re-run init:\n` +
        `  macOS (Homebrew): ${MACOS_INSTALL}\n` +
        `  Linux (official script): ${LINUX_INSTALL}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'OllamaUnreachableError';
  }
}

export class ModelPullError extends Error {
  constructor(model: string, reason: string) {
    super(`Failed to pull Ollama model "${model}": ${reason}`);
    this.name = 'ModelPullError';
  }
}

export class ModelVerificationError extends Error {
  constructor(model: string, kind: 'embed', reason: string) {
    super(`Round-trip verification failed for Ollama model "${model}" (${kind}): ${reason}`);
    this.name = 'ModelVerificationError';
  }
}

/** `aion doctor` surfaces this distinctly: a mismatch means the vector index needs a reindex, not a retry. */
export class EmbedDimensionMismatchError extends Error {
  constructor(model: string, expected: number, actual: number) {
    super(
      `Embedding model "${model}" returned ${actual}-dimensional vectors; ` +
        `AION_EMBED_DIMENSION is set to ${expected}. Update the env var or the embed model.`,
    );
    this.name = 'EmbedDimensionMismatchError';
  }
}
