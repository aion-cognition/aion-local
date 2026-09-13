import { summarizeErrorBody } from './errors.js';

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
  /** The one model Ollama still serves. Everything else resident is another program's. */
  readonly embedModel: string;
  readonly fetchImpl?: typeof fetch;
};

export type ReconciliationReport = {
  /** False when Ollama was never asked, which is not a state this produces any more. */
  readonly checked: boolean;
  readonly resident: readonly string[];
  /** Whether the embedding model is one of them. */
  readonly embedResident: boolean;
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
    throw new Error(
      `Ollama /api/ps failed: ${String(response.status)} ${summarizeErrorBody(await response.text())}`,
    );
  }
  const body = (await response.json()) as { models?: { name?: unknown; size?: unknown }[] };
  return (body.models ?? [])
    .filter((model): model is { name: string; size?: number } => typeof model.name === 'string')
    .map((model) => {
      return {
        name: model.name,
        sizeBytes: typeof model.size === 'number' ? model.size : undefined,
      };
    });
}

/**
 * Reads what Ollama is holding against the one model this substrate still needs from it, at
 * service boot and at the end of `aion init`.
 *
 * Nothing is unloaded. Generation runs remotely, so the only Ollama model this program names is
 * the embedder, and the embedder is the vector index: unloading it would put its reload inside
 * the next recall. Anything else resident belongs to another program on the machine, and
 * evicting another program's weights is not this one's decision to take.
 *
 * Ollama being down is reported rather than thrown. Boot does not depend on this, and a machine
 * with no Ollama running has nothing resident to read in the first place.
 */
export async function reconcileResidentModels(
  options: ReconciliationOptions,
): Promise<ReconciliationReport> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let resident: readonly ResidentModel[];
  try {
    resident = await listResidentModels(options.baseUrl, { fetchImpl });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      checked: true,
      resident: [],
      embedResident: false,
      error,
      detail: `could not read resident models: ${error}`,
    };
  }

  const tags = new Set(resident.map((model) => normalizeTag(model.name)));
  const embedResident = tags.has(normalizeTag(options.embedModel));
  const others = resident.filter(
    (model) => normalizeTag(model.name) !== normalizeTag(options.embedModel),
  );

  return {
    checked: true,
    resident: resident.map((model) => model.name),
    embedResident,
    error: undefined,
    detail: embedResident
      ? `${options.embedModel} is resident${others.length === 0 ? '' : `; ${String(others.length)} other model(s) in memory belong to something else`}`
      : `${options.embedModel} is not resident; the first embed loads it`,
  };
}
