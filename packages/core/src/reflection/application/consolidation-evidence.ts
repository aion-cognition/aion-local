import {
  derivedNode,
  owesBirthEstablishment,
  publishDerivedNodeEvidence,
} from './derived-node-evidence.js';
import { DERIVES_FROM_TYPE } from '../../infrastructure/graph/narrative-queries.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { committedIncidenceForNodesAt } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';

/**
 * What the records say stands behind the consolidation: the sources its members already carry.
 *
 * A consolidation is derived from claims rather than from a capture, so it has no source of its
 * own. What it does have is every source its members were extracted from, and those are the
 * occurrences a judge shown this claim is entitled to. The node's own censuses are established
 * here because this write drew the id.
 */
export async function recordConsolidationEvidence(
  deps: {
    readonly db: SqliteHandle;
    readonly publications?: PublicationCoordinator;
  },
  input: {
    readonly claimId: string;
    readonly memberIds: readonly string[];
    readonly minted: boolean;
    readonly now: Date;
  },
): Promise<string | undefined> {
  if (deps.publications === undefined) {
    return 'no publication coordinator';
  }
  const sources = [
    ...new Set(
      committedIncidenceForNodesAt(deps.db, input.memberIds, undefined)
        .filter((row) => row.currency === 'open' && row.role === 'extraction')
        .map((row) => row.sourceId),
    ),
  ].sort();
  if (sources.length === 0) {
    return 'the members name no committed source';
  }
  // The claim id is folded from the window and the member set, so a write that finds it already
  // there is finishing its own earlier attempt. While nothing has counted the id, the census that
  // attempt owed is still owed, and this one makes it.
  const minted = input.minted || owesBirthEstablishment(deps.db, input.claimId);
  const outcome = await publishDerivedNodeEvidence(
    { publications: deps.publications, now: input.now },
    {
      subject: input.claimId,
      nodes: sources.map((sourceId) =>
        derivedNode({
          nodeId: input.claimId,
          role: 'extraction',
          relationType: DERIVES_FROM_TYPE,
          sourceId,
          minted,
        }),
      ),
    },
  );
  return outcome.status === 'published' ? undefined : outcome.reason;
}
