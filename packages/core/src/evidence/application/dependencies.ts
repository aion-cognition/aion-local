import {
  buildEvidenceRevision,
  type EvidenceDependency,
  type EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { listStatedLinks } from '../../infrastructure/sqlite/evidence-links.js';
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
  type SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { committedSourceStates } from '../../infrastructure/sqlite/source-states.js';
import { hashContent } from '../../reflection/domain/content.js';
import { scopeAuthority, SOURCE_STATE_SCOPE } from '../domain/scopes.js';

/**
 * What a read observed, and how a later writer finds out that it changed.
 *
 * A dependency is the whole tuple of record kind, endpoint and scope, and its version comes
 * from the store that owns it. The fixed source scopes are versioned by the records that own
 * them: the content by the proof behind it, the parts by the mapping a read was taken under, the
 * state and reference history by what has been committed. A relation scope is different: what it
 * returns is only a membership once a census has counted it, and a reader never mints that proof
 * by looking.
 */

/**
 * The part mapping a read was taken under, original ids included. A changed turn mapping is a
 * changed answer about which node holds which capture, so it has to move the version even though
 * the bytes behind it did not.
 */
export function partsDigest(parts: readonly SourcePartRecord[]): string {
  return hashContent(
    parts.map((part) => [
      part.partKind,
      part.ordinal,
      part.contentHash,
      part.role ?? '',
      part.turnId ?? '',
      part.occurredAt ?? '',
    ]),
  );
}

/**
 * The proof state behind the content, not only the content. A record that loses verification
 * still carries the digest it once proved, so a reader fenced on the digest alone would go on
 * treating an unproved occurrence as the one it read.
 */
function contentProofVersion(record: SourceRecord): string {
  return hashContent([
    record.verifiedContentDigest ?? '',
    record.verificationStatus,
    record.identityHash ?? '',
    record.canonicalArchiveId ?? '',
    record.archiveSchemaVersion ?? 0,
    record.verificationPolicyVersion ?? 0,
  ]);
}

/**
 * What a reader that consulted suppression fences on: the state chain, and the census that says
 * whether the chain's silence means anything.
 *
 * Both are read to decide whether a source may be quoted at a past vantage, so both belong in the
 * one token. A version taken from the chain alone goes on calling itself current after a backfill
 * establishes the census and turns an unprovable silence into a proved absence, which is a
 * different answer about the same source.
 */
export function sourceStateDependency(db: SqliteHandle, sourceId: string): EvidenceDependency {
  const key = { endpointId: sourceId, relationClass: SOURCE_STATE_SCOPE };
  return {
    kind: 'source',
    id: sourceId,
    scope: SOURCE_STATE_SCOPE,
    version: hashContent({
      chain: committedSourceStates(db, sourceId).at(-1)?.version ?? 0,
      counted: scopeSupportsVerifiedEmpty(db, key),
      census: publishedScopeToken(db, key) ?? '',
    }),
  };
}

/** The recorded part mapping, which a read that resolved a part to its source consulted. */
export function sourcePartsDependency(db: SqliteHandle, sourceId: string): EvidenceDependency {
  return {
    kind: 'source',
    id: sourceId,
    scope: 'source.parts',
    version: partsDigest(readSourceParts(db, sourceId)),
  };
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
  return [
    { kind: 'source', id: sourceId, scope: 'source.content', version: contentProofVersion(record) },
    sourcePartsDependency(db, sourceId),
    sourceStateDependency(db, sourceId),
    {
      kind: 'source',
      id: sourceId,
      scope: 'source.references',
      version: referenceStateVersion(db, sourceId),
    },
  ];
}

/**
 * What the substrate has accepted and what it has committed, kept apart.
 *
 * An accepted batch says a delivery arrived; a committed link version says the evidence entered
 * the view a reader may cite. Folding the two into one number would let an unacknowledged
 * delivery pass for settled reference state.
 */
function referenceStateVersion(db: SqliteHandle, sourceId: string): string {
  const accepted = listReferenceBatches(db, sourceId).at(-1)?.referenceVersion ?? 0;
  const committed = listStatedLinks(db, sourceId)
    .filter((link) => link.knownFrom !== null)
    .map((link) => [link.linkId, link.version, link.knownFrom]);
  return hashContent({ accepted, committed });
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
  // The census gates every reading of a relation set, not only an empty one. A partially
  // inventoried scope can hold members nobody has counted, so what it returns is a sample rather
  // than the membership a judgment is entitled to treat as whole.
  if (!scopeSupportsVerifiedEmpty(db, key)) {
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
  | { readonly status: 'unverifiable'; readonly unknown: readonly EvidenceDependency[] }
  /**
   * The coverage contract a decision was taken under is no longer the one in force, or the
   * decision names none. Every dependency it read can be untouched and this still holds: what
   * moved is what the judge was allowed to see, which no dependency version records.
   */
  | { readonly status: 'uncovered'; readonly reason: 'epoch_changed' | 'binding_absent' };

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
