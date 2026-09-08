import {
  buildEvidenceRevision,
  type EvidenceDependency,
  type EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';
import { committedSourceStates } from '../../infrastructure/sqlite/committed-evidence.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  publishedScopeToken,
  readScopeMirror,
  scopeSupportsVerifiedEmpty,
  scopeVersionToken,
} from '../../infrastructure/sqlite/evidence-scope.js';
import {
  listReferenceBatches,
  readSourceParts,
  readSourceRecord,
  type SourcePartRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { hashContent } from '../../reflection/domain/content.js';
import { scopeAuthority } from '../domain/scopes.js';

/**
 * What a read observed, and how a later writer finds out that it changed.
 *
 * A dependency is the whole tuple of record kind, endpoint and scope, and its version comes
 * from the store that owns it. The fixed source scopes are versioned by the durable records
 * themselves, so an empty state chain or an empty reference history is a positive answer. A
 * relation scope is different: an empty relation set is only evidence of emptiness once a
 * census has established it, and a reader never mints that proof by looking.
 */

export function partsDigest(parts: readonly SourcePartRecord[]): string {
  return hashContent(
    parts.map((part) => [part.partKind, part.ordinal, part.contentHash, part.role ?? '']),
  );
}

/** The four fixed source scopes, versioned from the records that own them. */
export function sourceScopeDependencies(
  db: SqliteHandle,
  sourceId: string,
): readonly EvidenceDependency[] {
  const record = readSourceRecord(db, sourceId);
  if (record === undefined) {
    return [];
  }
  const digest = record.verifiedContentDigest;
  const states = committedSourceStates(db, sourceId);
  const batches = listReferenceBatches(db, sourceId);
  return [
    // An unverified occurrence cites no content version: there is nothing a later reader could
    // compare against.
    ...(digest === null
      ? []
      : [{ kind: 'source' as const, id: sourceId, scope: 'source.content', version: digest }]),
    {
      kind: 'source',
      id: sourceId,
      scope: 'source.parts',
      version: partsDigest(readSourceParts(db, sourceId)),
    },
    {
      kind: 'source',
      id: sourceId,
      scope: 'source.state',
      version: String(states.at(-1)?.version ?? 0),
    },
    {
      kind: 'source',
      id: sourceId,
      scope: 'source.references',
      version: String(batches.at(-1)?.referenceVersion ?? 0),
    },
  ];
}

export type ScopeReadInput = {
  readonly kind: EvidenceDependency['kind'];
  readonly endpointId: string;
  readonly scope: string;
  /** Whether the read found no relations. An empty set needs a census before it means anything. */
  readonly empty: boolean;
};

export type ScopeReading =
  | { readonly status: 'verified'; readonly dependency: EvidenceDependency }
  | { readonly status: 'unverified' };

/**
 * One relation scope's observed version.
 *
 * A SQLite-owned scope publishes its own token. A graph-owned one is read from the recorded
 * mirror, which says what the graph's counter read at some moment: a match proves nothing on
 * its own, and the publication checkpoint is what certifies the read it belongs to.
 */
export function readRelationScope(db: SqliteHandle, input: ScopeReadInput): ScopeReading {
  const key = { endpointId: input.endpointId, relationClass: input.scope };
  if (input.empty && !scopeSupportsVerifiedEmpty(db, key)) {
    return { status: 'unverified' };
  }
  if (scopeAuthority(input.scope) === 'graph') {
    const mirror = readScopeMirror(db, key);
    return mirror === undefined
      ? { status: 'unverified' }
      : {
          status: 'verified',
          dependency: {
            kind: input.kind,
            id: input.endpointId,
            scope: input.scope,
            version: scopeVersionToken(input.endpointId, input.scope, mirror.mirroredRevision),
          },
        };
  }
  const token = publishedScopeToken(db, key);
  return token === undefined
    ? { status: 'unverified' }
    : {
        status: 'verified',
        dependency: {
          kind: input.kind,
          id: input.endpointId,
          scope: input.scope,
          version: token,
        },
      };
}

/** One request's observed dependency set, folded into the revision a writer fences on. */
export class EvidenceDependencies {
  readonly #entries: EvidenceDependency[] = [];

  add(dependency: EvidenceDependency): void {
    this.#entries.push(dependency);
  }

  addAll(dependencies: readonly EvidenceDependency[]): void {
    this.#entries.push(...dependencies);
  }

  list(): readonly EvidenceDependency[] {
    return this.#entries;
  }

  /** Records what was read. It establishes no version and proves no empty scope by itself. */
  revision(): EvidenceRevision {
    return buildEvidenceRevision(this.#entries);
  }
}

export type RevisionCheck =
  | { readonly status: 'current' }
  | { readonly status: 'stale'; readonly changed: readonly EvidenceDependency[] }
  /** A scope whose current version cannot be established. Neither current nor proved changed. */
  | { readonly status: 'unverifiable'; readonly unknown: readonly EvidenceDependency[] };

function currentVersion(db: SqliteHandle, dependency: EvidenceDependency): string | undefined {
  if (dependency.scope.startsWith('source.')) {
    return sourceScopeDependencies(db, dependency.id).find(
      (entry) => entry.scope === dependency.scope,
    )?.version;
  }
  const reading = readRelationScope(db, {
    kind: dependency.kind,
    endpointId: dependency.id,
    scope: dependency.scope,
    empty: false,
  });
  return reading.status === 'verified' ? reading.dependency.version : undefined;
}

/**
 * Whether the evidence a decision was made on still stands.
 *
 * A stale dependency refuses the decision that cites it: a correction, a resolved reference or a
 * changed required source between a judgment and its application is new evidence, and applying
 * the old answer would close a claim on a reading nobody holds any more. A scope whose current
 * version cannot be read is its own answer, kept apart from both, because a writer must not
 * treat an unreadable store as agreement.
 */
export function verifyEvidenceRevision(
  db: SqliteHandle,
  revision: EvidenceRevision,
): RevisionCheck {
  const changed: EvidenceDependency[] = [];
  const unknown: EvidenceDependency[] = [];
  for (const dependency of revision.dependencies) {
    const version = currentVersion(db, dependency);
    if (version === undefined) {
      unknown.push(dependency);
    } else if (version !== dependency.version) {
      changed.push(dependency);
    }
  }
  if (changed.length > 0) {
    return { status: 'stale', changed };
  }
  return unknown.length > 0 ? { status: 'unverifiable', unknown } : { status: 'current' };
}
