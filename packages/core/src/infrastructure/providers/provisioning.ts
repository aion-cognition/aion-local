import {
  EmbedDimensionMismatchError,
  ModelPullError,
  ModelVerificationError,
  OllamaUnreachableError,
} from './errors.js';

export type OllamaProvisionTarget = {
  baseUrl: string;
  embedModel: string;
  embedDimension: number;
  cueModel: string;
  reflectModel: string;
};

export type ProvisionEvent =
  | { type: 'reachable' }
  | { type: 'pull_progress'; model: string; status: string; completed?: number; total?: number }
  | { type: 'pull_done'; model: string }
  | { type: 'verify_done'; model: string; kind: 'embed' | 'chat' };

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
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

/** Installed model names, newest-first as Ollama returns them. `aion status` renders this. */
export async function listOllamaModels(
  baseUrl: string,
  options: Pick<ProvisionOptions, 'fetchImpl'> = {},
): Promise<readonly string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/tags`);
  if (!response.ok) {
    throw new OllamaUnreachableError(baseUrl, new Error(`${response.status} ${await response.text()}`));
  }
  const body = (await response.json()) as { models?: { name?: unknown }[] };
  return (body.models ?? [])
    .map((model) => model.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Ollama's pull/chat streams are newline-delimited JSON over a single HTTP
 * response body; this has no framing beyond "split on \n", so a stalled or
 * truncated chunk boundary is handled by carrying the remainder to the next read.
 */
async function readNdjson(response: Response, onLine: (line: Record<string, unknown>) => void): Promise<void> {
  const body = response.body;
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
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
  const rest = buffer.trim();
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
    throw new ModelPullError(model, `${response.status} ${await response.text()}`);
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
    throw new ModelPullError(model, `stream ended without a "success" status (last: "${lastStatus}")`);
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
    throw new ModelVerificationError(model, 'embed', `${response.status} ${await response.text()}`);
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
 * A 5-token generate. Some chat models (qwen3's thinking variants) spend a budget that
 * small on `thinking` and return empty `content`, so this checks that the model produced
 * a completed message, not that `content` itself is non-empty.
 */
async function verifyChatModel(
  baseUrl: string,
  model: string,
  fetchImpl: typeof fetch,
  onEvent?: (event: ProvisionEvent) => void,
): Promise<void> {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'reply with one word' }],
      stream: false,
      options: { num_predict: 5 },
    }),
  });
  if (!response.ok) {
    throw new ModelVerificationError(model, 'chat', `${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { message?: unknown; done?: boolean };
  if (typeof body.message !== 'object' || body.message === null || body.done !== true) {
    throw new ModelVerificationError(model, 'chat', 'response did not complete with a message');
  }
  onEvent?.({ type: 'verify_done', model, kind: 'chat' });
}

/**
 * Init-time provisioning: reachability, then pull the three configured models
 * (deduped, since cue and reflect may name the same model) via `/api/pull`, then one
 * round-trip verification per model. Throws the first named error encountered; the
 * CLI surfaces it and exits.
 */
export async function provisionOllama(target: OllamaProvisionTarget, options: ProvisionOptions = {}): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;

  await checkOllamaReachable(target.baseUrl, {
    fetchImpl,
    reachabilityTimeoutMs: options.reachabilityTimeoutMs,
  });
  options.onEvent?.({ type: 'reachable' });

  const chatModels = [...new Set([target.cueModel, target.reflectModel])];
  const allModels = [...new Set([target.embedModel, ...chatModels])];

  for (const model of allModels) {
    await pullModel(target.baseUrl, model, fetchImpl, options.onEvent);
  }

  await verifyEmbedModel(target.baseUrl, target.embedModel, target.embedDimension, fetchImpl, options.onEvent);
  for (const model of chatModels) {
    await verifyChatModel(target.baseUrl, model, fetchImpl, options.onEvent);
  }
}
