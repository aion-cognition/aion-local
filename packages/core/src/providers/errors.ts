const MACOS_INSTALL = 'brew install ollama && brew services start ollama';
const LINUX_INSTALL = 'curl -fsSL https://ollama.com/install.sh | sh';

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
