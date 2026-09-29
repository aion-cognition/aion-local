import {
  EmbedDimensionMismatchError,
  ModelPullError,
  ModelVerificationError,
  OllamaUnreachableError,
  summarizeErrorBody,
} from './errors.js';

export type OllamaProvisionTarget = {
  baseUrl: string;
  embedModel: string;
  embedDimension: number;
};

export type ProvisionEvent =
  | { type: 'reachable' }
  | { type: 'pull_progress'; model: string; status: string; completed?: number; total?: number }
  | { type: 'pull_done'; model: string }
  | { type: 'verify_done'; model: string; kind: 'embed' };

export type ProvisionOptions = {
  fetchImpl?: typeof fetch;
  onEvent?: (event: ProvisionEvent) => void;
  reachabilityTimeoutMs?: number;
};

const DEFAULT_REACHABILITY_TIMEOUT_MS = 5_000;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export async function checkOllamaReachable(
  baseUrl: string,
  options: Pick<ProvisionOptions, 'fetchImpl' | 'reachabilityTimeoutMs'> = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.reachabilityTimeoutMs ?? DEFAULT_REACHABILITY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new OllamaUnreachableError(baseUrl);
    }
  } catch (err) {
    if (err instanceof OllamaUnreachableError) {
      throw err;
    }
    throw new OllamaUnreachableError(baseUrl, err);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The daemon's own version, which is the one runtime fact about it the HTTP API reports. Ollama
 * exposes no settings endpoint, so nothing else about how the daemon was started can be read
 * from here.
 */
export async function readOllamaVersion(
  baseUrl: string,
  options: Pick<ProvisionOptions, 'fetchImpl'> = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/version`);
  if (!response.ok) {
    throw new OllamaUnreachableError(
      baseUrl,
      new Error(`${response.status} ${summarizeErrorBody(await response.text())}`),
    );
  }
  const body = (await response.json()) as { version?: unknown };
  return typeof body.version === 'string' ? body.version : 'unknown';
}

/** Installed model names, newest-first as Ollama returns them. `aion status` renders this. */
export async function listOllamaModels(
  baseUrl: string,
  options: Pick<ProvisionOptions, 'fetchImpl'> = {},
): Promise<readonly string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/tags`);
  if (!response.ok) {
    throw new OllamaUnreachableError(
      baseUrl,
      new Error(`${response.status} ${summarizeErrorBody(await response.text())}`),
    );
  }
  const body = (await response.json()) as { models?: { name?: unknown }[] };
  return (body.models ?? [])
    .map((model) => model.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Ollama's pull/chat streams are newline-delimited JSON over a single HTTP
 * response body; this has no framing beyond "split on \n", so a chunk boundary that lands
 * mid-line is handled by carrying the remainder to the next read. The decoder is flushed at
 * EOF too, since a boundary can also land inside a multi-byte character and the held bytes
 * would otherwise be dropped from the last line.
 */
async function readNdjson(
  response: Response,
  onLine: (line: Record<string, unknown>) => void,
): Promise<void> {
  const { body } = response;
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    // Node's global fetch types leave a byte-stream reader's chunk untyped; it is a
    // `Uint8Array` (or absent at EOF) because nothing here requests a BYOB reader.
    const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        onLine(JSON.parse(line) as Record<string, unknown>);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  }
  const rest = (buffer + decoder.decode()).trim();
  if (rest.length > 0) {
    onLine(JSON.parse(rest) as Record<string, unknown>);
  }
}

async function pullModel(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch,
  onEvent?: (event: ProvisionEvent) => void,
): Promise<void> {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
  });
  if (!response.ok) {
    throw new ModelPullError(
      model,
      `${response.status} ${summarizeErrorBody(await response.text())}`,
    );
  }

  let lastStatus = '';
  let pullError: string | undefined;
  await readNdjson(response, (line) => {
    if (typeof line.error === 'string') {
      pullError = line.error;
      return;
    }
    if (typeof line.status !== 'string') {
      return;
    }
    lastStatus = line.status;
    onEvent?.({
      type: 'pull_progress',
      model,
      status: line.status,
      completed: typeof line.completed === 'number' ? line.completed : undefined,
      total: typeof line.total === 'number' ? line.total : undefined,
    });
  });

  if (pullError !== undefined) {
    throw new ModelPullError(model, pullError);
  }
  if (lastStatus !== 'success') {
    throw new ModelPullError(
      model,
      `stream ended without a "success" status (last: "${lastStatus}")`,
    );
  }
  onEvent?.({ type: 'pull_done', model });
}

async function verifyEmbedModel(
  baseUrl: string,
  model: string,
  expectedDimension: number,
  fetchImpl: typeof fetch,
  onEvent?: (event: ProvisionEvent) => void,
): Promise<void> {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: ['aion init embed round-trip'] }),
  });
  if (!response.ok) {
    throw new ModelVerificationError(
      model,
      'embed',
      `${response.status} ${summarizeErrorBody(await response.text())}`,
    );
  }

  const body = (await response.json()) as { embeddings?: number[][] };
  const vector = body.embeddings?.[0];
  if (vector === undefined) {
    throw new ModelVerificationError(model, 'embed', 'response had no embedding vector');
  }
  if (vector.length !== expectedDimension) {
    throw new EmbedDimensionMismatchError(model, expectedDimension, vector.length);
  }
  onEvent?.({ type: 'verify_done', model, kind: 'embed' });
}

/**
 * Init-time provisioning: reachability, then pull the embedding model via `/api/pull`, then one
 * round-trip verification of it. One model, because generation runs remotely and the vector
 * space is the only thing Ollama still owns. Throws the first named error encountered; the CLI
 * surfaces it and exits.
 */
export async function provisionOllama(
  target: OllamaProvisionTarget,
  options: ProvisionOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;

  await checkOllamaReachable(target.baseUrl, {
    fetchImpl,
    reachabilityTimeoutMs: options.reachabilityTimeoutMs,
  });
  options.onEvent?.({ type: 'reachable' });

  await pullModel(target.baseUrl, target.embedModel, fetchImpl, options.onEvent);

  await verifyEmbedModel(
    target.baseUrl,
    target.embedModel,
    target.embedDimension,
    fetchImpl,
    options.onEvent,
  );
}
