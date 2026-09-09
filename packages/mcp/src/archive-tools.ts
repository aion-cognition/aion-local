import {
  runSourceInspection,
  runSourceSearch,
  searchOutputFor,
  searchText,
  sourceOutputFor,
  sourceReadDeps,
  sourceText,
  type Logger,
  type SqliteHandle,
} from '@aion/core';
import { SourceInputSchema, SourceSearchInputSchema } from '@aion/protocol';
import type { Driver } from 'neo4j-driver';

import type { ToolBackend } from './tools.js';

/**
 * The archive half of the tool backend: the two explicit reads, parsed at the wire and answered
 * through the one resolver this process holds.
 *
 * Neither takes an identity. An explicit lookup creates no session, records no delivery, stamps
 * no access and enqueues nothing, so there is no caller state for one to belong to.
 */
export function archiveToolBackend(input: {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Logger;
}): Pick<ToolBackend, 'sourceSearch' | 'source'> {
  const deps = sourceReadDeps(input);
  return {
    sourceSearch: async (args) => {
      const parsed = SourceSearchInputSchema.parse(args);
      const output = searchOutputFor(
        await runSourceSearch(deps, {
          query: parsed.query,
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          ...(parsed.as_of === undefined ? {} : { asOf: parsed.as_of }),
          ...(parsed.knew_at === undefined ? {} : { knewAt: parsed.knew_at }),
        }),
      );
      return { output, text: searchText(output) };
    },
    source: async (args) => {
      const parsed = SourceInputSchema.parse(args);
      const output = sourceOutputFor(
        await runSourceInspection(deps, {
          ...(parsed.id === undefined ? {} : { id: parsed.id }),
          ...(parsed.part === undefined
            ? {}
            : {
                part: {
                  sourceId: parsed.part.source_id,
                  partKind: parsed.part.part_kind,
                  ordinal: parsed.part.ordinal,
                },
              }),
          ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          ...(parsed.as_of === undefined ? {} : { asOf: parsed.as_of }),
          ...(parsed.knew_at === undefined ? {} : { knewAt: parsed.knew_at }),
        }),
      );
      return { output, text: sourceText(output) };
    },
  };
}
