import { z } from 'zod';

import { canonicalJson, comparePublicationKeys, publicationDigest } from './json.js';

export type EvidenceDependency = {
  readonly kind: 'source' | 'node' | 'relation_scope';
  readonly id: string;
  readonly scope: string;
  readonly version: string;
};
export type EvidenceScope = Pick<EvidenceDependency, 'kind' | 'id' | 'scope'>;
export type EvidenceRevision = {
  readonly contractVersion: 1;
  readonly dependencies: readonly EvidenceDependency[];
  readonly digest: string;
};
export type SourceFence = {
  readonly sourceId: string;
  readonly generation: string;
  readonly acceptedReferenceVersion: string;
};
export type PublicationPreconditions = {
  readonly coverageEpoch: string;
  readonly evidence: EvidenceRevision;
  readonly sources: readonly SourceFence[];
  readonly heads: readonly {
    readonly chunkId: string;
    readonly publishedRevisionNo: number | null;
  }[];
};

const Dependency = z.strictObject({
  kind: z.enum(['source', 'node', 'relation_scope']),
  id: z.string().min(1),
  scope: z.string().min(1),
  version: z.string().min(1),
});
const Scope = Dependency.omit({ version: true });

/**
 * One identity per affected scope, including its record kind and endpoint.
 *
 * Shape only: kind, a non-empty id and a non-empty scope name. The name is NOT checked against
 * the closed scope registry, and four installed handlers declare names the registry rejects
 * (`sqlite:source_residency`, `sqlite:source_occurrence`, `migration.capture_order`). Nothing
 * calls `scopeAuthority` on a declared affected scope, so this is a recording gap rather than a
 * live failure: the stored list cannot be read as a registry-valid scope set, and a reconciliation
 * has to take the real set from the producers. Tightening the parse would refuse those four
 * handlers, which is a decision about the registry rather than about this reader.
 */
export function parseAffectedScopes(value: unknown): readonly EvidenceScope[] {
  const scopes = z.array(Scope).parse(value);
  const unique = new Map(
    scopes.map((scope) => [canonicalJson([scope.kind, scope.id, scope.scope]), scope]),
  );
  return [...unique.entries()]
    .sort(([a], [b]) => comparePublicationKeys(a, b))
    .map(([, scope]) => scope);
}
const Preconditions = z.strictObject({
  coverageEpoch: z.string().min(1),
  evidence: z.strictObject({
    contractVersion: z.literal(1),
    dependencies: z.array(Dependency),
    digest: z.string(),
  }),
  sources: z.array(
    z.strictObject({
      sourceId: z.string().min(1),
      generation: z.string().min(1),
      acceptedReferenceVersion: z.string().min(1),
    }),
  ),
  heads: z.array(
    z.strictObject({
      chunkId: z.string().min(1),
      publishedRevisionNo: z.number().int().nonnegative().nullable(),
    }),
  ),
});

/** Records the dependency set already read; it creates no store versions or empty-scope proof. */
export function buildEvidenceRevision(
  dependencies: readonly EvidenceDependency[],
): EvidenceRevision {
  const seen = new Map<string, EvidenceDependency>();
  for (const entry of dependencies) {
    const dependency = Dependency.parse(entry);
    const identity = canonicalJson([dependency.kind, dependency.id, dependency.scope]);
    const previous = seen.get(identity);
    if (previous !== undefined && previous.version !== dependency.version) {
      throw new Error('one dependency cannot have two observed versions');
    }
    seen.set(identity, dependency);
  }
  const sorted = [...seen.entries()]
    .sort(([a], [b]) => comparePublicationKeys(a, b))
    .map(([, dependency]) => dependency);
  return {
    contractVersion: 1,
    dependencies: sorted,
    digest: publicationDigest(canonicalJson({ contractVersion: 1, dependencies: sorted })),
  };
}

/** Scope authority and source/head validity remain the registered domain handler's checks. */
export function parsePublicationPreconditions(value: unknown): PublicationPreconditions {
  const parsed = Preconditions.parse(value);
  const evidence = buildEvidenceRevision(parsed.evidence.dependencies);
  if (evidence.digest !== parsed.evidence.digest) {
    throw new Error('evidence revision digest does not match its dependency set');
  }
  if (
    new Set(parsed.sources.map((source) => source.sourceId)).size !== parsed.sources.length ||
    new Set(parsed.heads.map((head) => head.chunkId)).size !== parsed.heads.length
  ) {
    throw new Error('publication source and head fences must be unique');
  }
  return { ...parsed, evidence };
}
