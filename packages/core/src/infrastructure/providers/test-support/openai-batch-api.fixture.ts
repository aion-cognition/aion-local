import { vi } from 'vitest';

/**
 * A fetch that answers the OpenAI Batch and Files endpoints from a script and records what was
 * asked, in the shapes the batch guide documents. No request leaves the process.
 *
 * The upload is recorded as the purpose and the JSONL text the multipart form carried, so a test
 * reads the lines the remote would have validated rather than a form object.
 */

export const OPENAI_BATCH_ID = 'batch_abc123';
export const OPENAI_INPUT_FILE = 'file-input';
export const OPENAI_OUTPUT_FILE = 'file-output';
export const OPENAI_ERROR_FILE = 'file-errors';

export type OpenAiBatchScript = {
  readonly uploadStatus?: number;
  readonly createStatus?: number;
  /** Successive answers to the status read. The last one repeats. */
  readonly statuses?: readonly string[];
  readonly output?: readonly Record<string, unknown>[];
  readonly errors?: readonly Record<string, unknown>[];
  /** The batch object's own `errors`, which a failed validation carries. */
  readonly batchErrors?: unknown;
  /** How many file deletions fail with a 500 before they start succeeding. */
  readonly deleteFailures?: number;
};

export type RecordedCall = {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly json?: unknown;
  readonly upload?: { readonly purpose: string; readonly filename: string; readonly text: string };
};

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers[name];
}

async function record(url: string, init: RequestInit | undefined): Promise<RecordedCall> {
  const method = init?.method ?? 'GET';
  const authorization = headerOf(init, 'authorization');
  const { body } = init ?? {};
  if (body instanceof FormData) {
    const file = body.get('file') as File;
    const purpose = body.get('purpose');
    return {
      method,
      url,
      authorization,
      upload: {
        purpose: typeof purpose === 'string' ? purpose : 'not a string',
        filename: file.name,
        text: await file.text(),
      },
    };
  }
  return {
    method,
    url,
    authorization,
    ...(typeof body === 'string' ? { json: JSON.parse(body) as unknown } : {}),
  };
}

function jsonl(lines: readonly Record<string, unknown>[] | undefined): string {
  return (lines ?? []).map((line) => JSON.stringify(line)).join('\n');
}

export function openAiBatchApi(script: OpenAiBatchScript = {}): {
  readonly calls: RecordedCall[];
  readonly impl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  let polls = 0;
  let deletions = 0;
  const impl = vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const call = await record(url, init);
    calls.push(call);
    const base = 'https://api.openai.com/v1';
    if (url === `${base}/files` && call.method === 'POST') {
      return script.uploadStatus === undefined
        ? Response.json({ id: OPENAI_INPUT_FILE, object: 'file', purpose: 'batch' })
        : new Response('upload refused', { status: script.uploadStatus });
    }
    if (url === `${base}/batches` && call.method === 'POST') {
      return script.createStatus === undefined
        ? Response.json({ id: OPENAI_BATCH_ID, object: 'batch', status: 'validating' })
        : new Response('{"error":{"message":"quota"}}', { status: script.createStatus });
    }
    if (url === `${base}/batches/${OPENAI_BATCH_ID}`) {
      const statuses = script.statuses ?? ['completed'];
      const status = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return Response.json({
        id: OPENAI_BATCH_ID,
        object: 'batch',
        status,
        input_file_id: OPENAI_INPUT_FILE,
        output_file_id: script.output === undefined ? null : OPENAI_OUTPUT_FILE,
        error_file_id: script.errors === undefined ? null : OPENAI_ERROR_FILE,
        ...(script.batchErrors === undefined ? {} : { errors: script.batchErrors }),
      });
    }
    if (url === `${base}/files/${OPENAI_OUTPUT_FILE}/content`) {
      return new Response(jsonl(script.output));
    }
    if (url === `${base}/files/${OPENAI_ERROR_FILE}/content`) {
      return new Response(jsonl(script.errors));
    }
    const deleted = /^https:\/\/api\.openai\.com\/v1\/files\/([^/]+)$/.exec(url);
    if (deleted !== null && call.method === 'DELETE') {
      deletions += 1;
      if (deletions <= (script.deleteFailures ?? 0)) {
        return new Response('storage unavailable', { status: 500 });
      }
      return Response.json({ id: deleted[1], object: 'file', deleted: true });
    }
    return new Response(`no scripted answer for ${call.method} ${url}`, { status: 404 });
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

/** A Responses body carrying one JSON answer and the usage OpenAI reports for it. */
export function responsesAnswer(
  json: string,
  usage: Record<string, unknown> = { input_tokens: 1000, output_tokens: 100 },
): Record<string, unknown> {
  return {
    id: 'resp_1',
    object: 'response',
    status: 'completed',
    model: 'gpt-6-luna-snapshot',
    output: [{ type: 'message', content: [{ type: 'output_text', text: json }] }],
    usage,
  };
}

/** One output-file line for a request the endpoint answered. */
export function outputLine(
  customId: string,
  body: Record<string, unknown>,
  statusCode = 200,
): Record<string, unknown> {
  return {
    id: `batch_req_${customId}`,
    custom_id: customId,
    response: { status_code: statusCode, request_id: `req_${customId}`, body },
    error: null,
  };
}

/** One error-file line for a request that got no answer. */
export function errorLine(
  customId: string,
  code: string,
  message = 'no answer',
): Record<string, unknown> {
  return {
    id: `batch_req_${customId}`,
    custom_id: customId,
    response: null,
    error: { code, message },
  };
}
