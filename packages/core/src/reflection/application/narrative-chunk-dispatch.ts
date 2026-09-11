import { publishChunkNarrative, sealSessionChunk } from './chunk-narrative.js';
import type { NarrativeDeps, NarrativeResult, NarrativeSettings } from './narratives.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/** A close that lost its legacy family dispatches the live remainder through the bounded writer. */
export async function dispatchChunkNarrative(
  deps: NarrativeDeps & {
    readonly db: SqliteHandle;
    readonly publications: PublicationCoordinator;
  },
  sessionId: string,
  settings: NarrativeSettings,
  closing: boolean,
): Promise<NarrativeResult> {
  const resolved = {
    ...deps,
    resolver:
      deps.resolver ??
      new EvidenceResolver({
        driver: deps.driver,
        db: deps.db,
        publications: deps.publications,
        logger: deps.logger,
      }),
  };
  const sealed = await sealSessionChunk(resolved, sessionId, {
    now: settings.now,
    sessionClosing: closing,
    ...(settings.chunkPolicy === undefined ? {} : { policy: settings.chunkPolicy }),
  });
  if (sealed.status !== 'sealed') {
    return {
      status: sealed.status === 'refused' ? 'failed' : 'skipped',
      sessionId,
      episodes: 0,
      summary: sealed.reason,
    };
  }
  const published = await publishChunkNarrative(resolved, sealed.chunkId, {
    now: settings.now,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    ...(settings.chunkPolicy === undefined ? {} : { policy: settings.chunkPolicy }),
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });
  return published.status === 'published'
    ? {
        status: 'created',
        sessionId,
        episodes: sealed.members.length,
        narrativeId: published.nodeId,
        version: published.revisionNo,
        summary: `chunk over ${String(sealed.members.length)} sources`,
      }
    : {
        status: published.status === 'skipped' ? 'skipped' : 'failed',
        sessionId,
        episodes: sealed.members.length,
        summary: published.reason,
      };
}
