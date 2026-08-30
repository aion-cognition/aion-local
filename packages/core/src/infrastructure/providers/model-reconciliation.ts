import { evictableModels, type ProviderRouting } from './routing.js';

/** Ollama answers `/api/ps` with fully qualified tags, so a bare name is compared as `:latest`. */
function normalizeTag(model: string): string {
  return model.includes(':') ? model : `${model}:latest`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export type ResidentModel = {
  readonly name: string;
  readonly sizeBytes: number | undefined;
};

export type ReconciliationOptions = {
  readonly baseUrl: string;
  readonly routing: ProviderRouting;
  readonly fetchImpl?: typeof fetch;
};

export type ReconciliationReport = {
  /** False when routing had nothing to unload, in which case Ollama is never called. */
  readonly checked: boolean;
  readonly resident: readonly string[];
  readonly evicted: readonly string[];
  /** Candidates routing no longer needs that were not in memory anyway. */
  readonly absent: readonly string[];
  /** Set when Ollama did not answer. Reconciliation is hygiene, so this is reported, not thrown. */
  readonly error: string | undefined;
  readonly detail: string;
};

/**
 * Models currently held in memory, as `/api/ps` reports them. `aion status` renders this next
 * to the installed list, which is the difference between what is on disk and what is resident.
 */
export async function listResidentModels(
  baseUrl: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<readonly ResidentModel[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/ps`);
  if (!response.ok) {
    throw new Error(`Ollama /api/ps failed: ${String(response.status)} ${await response.text()}`);
  }
  const body = (await response.json()) as { models?: { name?: unknown; size?: unknown }[] };
  return (body.models ?? [])
    .filter((model): model is { name: string; size?: number } => typeof model.name === 'string')
    .map((model) => {
      return { name: model.name, sizeBytes: typeof model.size === 'number' ? model.size : undefined };
    });
}

/**
 * A `keep_alive: 0` generate is Ollama's documented unload: the model leaves memory and stays
 * on disk, so the next call after a key is removed reloads it without a pull.
 */
async function unloadModel(baseUrl: string, model: string, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(`${normalizeBaseUrl(baseUrl)}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: 0, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`${String(response.status)} ${await response.text()}`);
  }
  await response.text().catch(() => undefined);
}

/**
 * Reconciles what Ollama is holding in memory against the resolved routing, at service boot
 * and at the end of `aion init`.
 *
 * A generation role that routes to Anthropic leaves its local model resident but unused, which
 * on a laptop is several gigabytes of unified memory the rest of the machine wanted. Only a
 * model no local role still names is unloaded, and the embedding model never is: it runs under
 * every route. Nothing is removed from disk, so taking the key back out and restarting is a
 * reload, not a re-download.
 *
 * Ollama being down is reported rather than thrown. Boot does not depend on this, and a
 * machine with no Ollama running has nothing resident to reconcile in the first place.
 */
export async function reconcileResidentModels(
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const candidates = evictableModels(options.routing);
  if (candidates.length === 0) {
    return {
      checked: false,
      resident: [],
      evicted: [],
      absent: [],
      error: undefined,
      detail: 'every generation role is local; nothing to unload',
    };
  }

  let resident: readonly ResidentModel[];
  try {
    resident = await listResidentModels(options.baseUrl, { fetchImpl });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      checked: true,
      resident: [],
      evicted: [],
      absent: candidates,
      error,
      detail: `could not read resident models: ${error}`,
    };
  }

  const residentByTag = new Map(resident.map((model) => [normalizeTag(model.name), model.name]));
  const evicted: string[] = [];
  const absent: string[] = [];
  const failures: string[] = [];

  for (const candidate of candidates) {
    const residentName = residentByTag.get(normalizeTag(candidate));
    if (residentName === undefined) {
      absent.push(candidate);
      continue;
    }
    try {
      await unloadModel(options.baseUrl, residentName, fetchImpl);
      evicted.push(residentName);
    } catch (err) {
      failures.push(`${residentName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const detail =
    evicted.length === 0
      ? `no key-covered model was resident (${absent.join(', ')} on disk, not in memory)`
      : `unloaded ${evicted.join(', ')} from memory; models stay on disk`;

  return {
    checked: true,
    resident: resident.map((model) => model.name),
    evicted,
    absent,
    error: failures.length === 0 ? undefined : failures.join('; '),
    detail: failures.length === 0 ? detail : `${detail}; failed: ${failures.join('; ')}`,
  };
}
