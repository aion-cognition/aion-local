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

/** A non-2xx answer from Ollama. `kind` names the endpoint that refused. */
export class OllamaRequestError extends Error {
  readonly status: number;

  constructor(kind: 'embed' | 'generate', status: number, body: string) {
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
  constructor(model: string, kind: 'embed' | 'chat', reason: string) {
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
