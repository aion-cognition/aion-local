import { hashContent } from './content.js';
import type {
  SessionEpisode,
  SessionSourceNode,
} from '../../infrastructure/graph/narrative-queries.js';
import type { EvidenceDependency } from '../../infrastructure/publication/preconditions.js';

export type LegacyNarrativeFence = {
  readonly familyVersion: number;
  readonly familyDependency: EvidenceDependency;
  readonly heads: readonly string[];
  readonly coverageEpoch: string;
  readonly inputDigest: string;
  readonly includeExtracted: boolean;
};

export class LegacyPublicationDeferred extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`legacy narrative deferred: ${reason}`);
    this.name = 'LegacyPublicationDeferred';
    this.reason = reason;
  }
}

/** Hashes the exact graph fields the legacy renderer consumed, including its summary preference. */
export function legacyInputDigest(
  episodes: readonly SessionEpisode[],
  extracted: readonly SessionSourceNode[],
): string {
  return hashContent({ episodes, extracted });
}
