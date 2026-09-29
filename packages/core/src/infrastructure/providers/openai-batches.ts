import { z } from 'zod';

import type { UsageCounters } from './anthropic-usage.js';
import {
  BatchAnswerRefusedError,
  BatchNotCreatedError,
  type BatchClientOptions,
  type BatchPoll,
  type BatchRequest,
  type BatchRequestBound,
  type BatchResult,
  type BatchTransport,
} from './batch-transport.js';
import {
  OpenAiRefusalError,
  OpenAiRequestError,
  readResponsesAnswer,
  responsesCacheWriteClass,
} from './openai-provider.js';
import { readOpenAiUsage } from './openai-usage.js';
import type { GenerationProvider } from './types.js';

/**
 * The OpenAI Batch API as the batch lane's transport, by raw HTTP.
 *
 * Shapes confirmed 2026-09-28 against https://developers.openai.com/api/docs/guides/batch and the
 * batch and file references beside it. The requests go up as one JSONL file (`POST /v1/files`,
 * multipart, `purpose` "batch"), each line `{custom_id, method: "POST", url, body}`. The job is
 * `POST /v1/batches` with `input_file_id`, `endpoint` "/v1/responses" and `completion_window`
 * "24h", the only window offered. `GET /v1/batches/{id}` names its status, and once it has ended,
 * `output_file_id` for the answers and `error_file_id` for the requests that got none, each read
 * from `GET /v1/files/{id}/content`. The guide warns that output order may not match input order,
 * so answers are matched by `custom_id` like the Anthropic lane's. Batch requests bill at half the
 * synchronous rate, the same multiplier the Anthropic lane carries.
 *
 * Each body is the synchronous route's own Responses request (`responsesRequestBody`), and each
 * answer is decoded by the synchronous route's own reader, so the two lanes ask and read alike.
 */

const OPENAI_API_URL = 'https://api.openai.com/v1';

/** What every line and the job itself name, so the two cannot disagree. */
const RESPONSES_ENDPOINT = '/v1/responses';

/** The guide's ceiling on requests in one job. The lane submits far fewer. */
export const MAX_OPENAI_BATCH_REQUESTS = 50_000;

/**
 * The statuses after which neither file changes. `failed` is apart from them: it is the input file
 * failing validation, which leaves no request run and no file to read.
 */
const ENDED_STATUSES: ReadonlySet<string> = new Set(['completed', 'expired', 'cancelled']);

/** The error code the guide gives a request the 24-hour window closed on before it ran. */
const EXPIRED_CODE = 'batch_expired';

const FILE_SCHEMA = z.object({ id: z.string().min(1) });

/**
 * Read loosely on purpose. A status this reader does not know reads as still working rather than
 * as unreadable, and an accepted job is identified by its id whatever else the answer carries.
 */
const BATCH_SCHEMA = z.object({
  id: z.string().min(1),
  status: z.string().optional(),
  input_file_id: z.string().min(1).nullish(),
  output_file_id: z.string().min(1).nullish(),
  error_file_id: z.string().min(1).nullish(),
  errors: z.unknown().optional(),
});

const LINE_SCHEMA = z.object({
  custom_id: z.string().min(1),
  response: z.object({ status_code: z.number().int(), body: z.unknown().optional() }).nullish(),
  error: z.object({ code: z.string().nullish(), message: z.string().nullish() }).nullish(),
});

/** Capped the way the Anthropic lane caps its own, since it reaches a row's `last_error`. */
function detailOf(value: unknown): string {
  return JSON.stringify(value ?? null).slice(0, 200);
}

/**
 * One line of an output or error file as the lane's outcome. A 2xx response is an answer and is
 * billed. A line carrying an error, or a response the endpoint answered with anything but 2xx, is
 * a request that got no answer, which the lane owes again. A line that is neither is dropped.
 */
function resultOf(line: z.infer<typeof LINE_SCHEMA>): BatchResult | undefined {
  const { custom_id: customId, response, error } = line;
  if (response !== null && response !== undefined) {
    if (response.status_code >= 200 && response.status_code < 300) {
      return { customId, type: 'succeeded', message: response.body };
    }
    const body = response.body as { error?: unknown } | null | undefined;
    return {
      customId,
      type: 'errored',
      detail: detailOf({ status_code: response.status_code, error: body?.error }),
    };
  }
  if (error !== null && error !== undefined) {
    return {
      customId,
      type: error.code === EXPIRED_CODE ? 'expired' : 'errored',
      detail: detailOf(error),
    };
  }
  return undefined;
}

export class OpenAiBatchTransport implements BatchTransport {
  readonly provider: GenerationProvider = 'openai';
  readonly maxRequests = MAX_OPENAI_BATCH_REQUESTS;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(options: BatchClientOptions) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * The write class is read off the stored body, as on the synchronous route: a body built with
   * cache writes off holds at the ordinary input rate, and one stored before that holds at the
   * write rate it can still be billed.
   */
  bound(request: unknown): BatchRequestBound {
    const body = (request ?? {}) as { model?: unknown; max_output_tokens?: unknown };
    return {
      model: typeof body.model === 'string' ? body.model : undefined,
      outputTokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 0,
      ...responsesCacheWriteClass(request),
    };
  }

  /**
   * Uploads the requests and creates the job over them. An upload the API refused to create a job
   * over is deleted on the way out: it holds memory text, and a re-send uploads a file of its own.
   * Only a refusal deletes it. A creation whose answer was lost may be a job that is running, and
   * that job reads the file.
   *
   * A failed upload and a refused creation both leave no job, and say so as `BatchNotCreatedError`
   * so the hold is released. A creation whose answer was lost says nothing of the kind.
   */
  async create(requests: readonly BatchRequest[]): Promise<string> {
    const lines = requests.map((request) =>
      JSON.stringify({
        custom_id: request.customId,
        method: 'POST',
        url: RESPONSES_ENDPOINT,
        body: request.params,
      }),
    );
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append(
      'file',
      new Blob([`${lines.join('\n')}\n`], { type: 'application/jsonl' }),
      'batch.jsonl',
    );
    let uploaded: z.infer<typeof FILE_SCHEMA>;
    try {
      uploaded = FILE_SCHEMA.parse(
        await (await this.#send('/files', { method: 'POST', body: form })).json(),
      );
    } catch (err) {
      // No file id came back, so no job can have been created over this upload.
      throw new BatchNotCreatedError('the batch input file was not uploaded', { cause: err });
    }
    let created: Response;
    try {
      created = await this.#send('/batches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input_file_id: uploaded.id,
          endpoint: RESPONSES_ENDPOINT,
          completion_window: '24h',
        }),
      });
    } catch (err) {
      if (err instanceof OpenAiRequestError) {
        await this.#deleteFile(uploaded.id).catch(() => undefined);
        throw new BatchNotCreatedError('the batch API refused to create the job', { cause: err });
      }
      throw err;
    }
    return BATCH_SCHEMA.parse(await created.json()).id;
  }

  /**
   * Deletes the files a settled job left in OpenAI's storage: the requests it was sent and the
   * answers it wrote. Each holds memory text, `store: false` does not reach them, and the Files
   * API keeps them until they are deleted. Nothing reads them once every row the job carried has
   * settled. A file already gone counts as deleted.
   */
  async release(batchId: string): Promise<void> {
    const response = await this.#send(`/batches/${encodeURIComponent(batchId)}`, {
      method: 'GET',
    });
    const batch = BATCH_SCHEMA.parse(await response.json());
    for (const fileId of [batch.input_file_id, batch.output_file_id, batch.error_file_id]) {
      if (typeof fileId === 'string') {
        await this.#deleteFile(fileId);
      }
    }
  }

  async poll(batchId: string): Promise<BatchPoll> {
    const response = await this.#send(`/batches/${encodeURIComponent(batchId)}`, {
      method: 'GET',
    });
    const batch = BATCH_SCHEMA.parse(await response.json());
    if (batch.status === 'failed') {
      return { state: 'refused', detail: `failed: ${detailOf(batch.errors)}` };
    }
    if (batch.status === undefined || !ENDED_STATUSES.has(batch.status)) {
      return { state: 'working' };
    }
    const sources = [batch.output_file_id, batch.error_file_id].filter(
      (fileId): fileId is string => typeof fileId === 'string',
    );
    // Neither file changes once the job has ended, so a request neither names (a line that would
    // not parse, or one a cancellation never ran) got no answer and will not get one.
    return { state: 'ended', sources, final: true };
  }

  /**
   * Every line of the output and error files. A line that will not parse is dropped rather than
   * failing the read, so one malformed line cannot strand the rest; its row stays outstanding.
   */
  async results(sources: readonly string[]): Promise<readonly BatchResult[]> {
    const read: BatchResult[] = [];
    for (const fileId of sources) {
      const response = await this.#send(`/files/${encodeURIComponent(fileId)}/content`, {
        method: 'GET',
      });
      for (const line of (await response.text()).split('\n')) {
        if (line.trim().length === 0) {
          continue;
        }
        let parsed;
        try {
          parsed = LINE_SCHEMA.safeParse(JSON.parse(line));
        } catch {
          continue;
        }
        const result = parsed.success ? resultOf(parsed.data) : undefined;
        if (result !== undefined) {
          read.push(result);
        }
      }
    }
    return read;
  }

  answerOf(message: unknown): unknown {
    try {
      return readResponsesAnswer(message);
    } catch (err) {
      if (err instanceof OpenAiRefusalError) {
        throw new BatchAnswerRefusedError(err.message);
      }
      throw err;
    }
  }

  /**
   * Priced under the model the stored request named, which is what the synchronous route records,
   * so both lanes bill one model under one name. The response's own name stands in only for an
   * answer no current work holds.
   */
  chargeOf(
    message: unknown,
    request: unknown,
  ): { readonly model: string; readonly usage: UsageCounters } {
    const response = message as { model?: unknown; usage?: unknown } | null;
    const asked = (request as { model?: unknown } | undefined)?.model;
    const answered = response?.model;
    let model = 'unknown';
    if (typeof asked === 'string') {
      model = asked;
    } else if (typeof answered === 'string') {
      model = answered;
    }
    return { model, usage: readOpenAiUsage(response?.usage) };
  }

  async #deleteFile(fileId: string): Promise<void> {
    try {
      await this.#send(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    } catch (err) {
      if (!(err instanceof OpenAiRequestError && err.status === 404)) {
        throw err;
      }
    }
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    const response = await this.#fetch(`${OPENAI_API_URL}${path}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        authorization: `Bearer ${this.#apiKey}`,
      },
    });
    if (!response.ok) {
      throw new OpenAiRequestError(response.status, await response.text());
    }
    return response;
  }
}
