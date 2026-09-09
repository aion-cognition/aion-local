import { SOURCE_TOOL_SCHEMA_VERSION } from '@aion/protocol';

import type { ToolBackend } from './tools.js';

/**
 * The archive half of a tool backend, for the fixtures whose subject is the recall or
 * reflection path. It refuses rather than pretending to search: a fixture that answered would
 * let a test pass on an archive read nothing in it wired up.
 */
export function refusingArchiveBackend(): Pick<ToolBackend, 'sourceSearch' | 'source'> {
  return {
    sourceSearch: () =>
      Promise.resolve({
        output: {
          schema_version: SOURCE_TOOL_SCHEMA_VERSION,
          status: 'search_unavailable',
          cause: 'search_store_error',
          detail: 'no archive backend is wired into this fixture',
        },
        text: 'no archive backend is wired into this fixture',
      }),
    source: () =>
      Promise.resolve({
        output: {
          schema_version: SOURCE_TOOL_SCHEMA_VERSION,
          status: 'invalid_request',
          field: 'id',
          message: 'no archive backend is wired into this fixture',
        },
        text: 'no archive backend is wired into this fixture',
      }),
  };
}
