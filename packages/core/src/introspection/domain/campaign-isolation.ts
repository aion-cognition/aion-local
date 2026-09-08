import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, sep } from 'node:path';

/**
 * The check a rehearsal runner makes before it loads a fixture, injects a fault, or tears a
 * substrate down. Those runs delete, restart, and restore, so the target has to be a substrate
 * nobody minds losing, and the way to know that is to name it rather than to infer it.
 *
 * Two rules. A target that resolves to the running endpoint or shares its data directory is
 * refused, because a teardown there reaches the real volume. And a target nobody declared is
 * refused too: an environment variable pointing somewhere is not evidence that the somewhere
 * is disposable, so a caller states what it built and the statement is checked against what it
 * is about to connect to.
 *
 * Paths are compared by filesystem identity, not by spelling. A symlink makes two names for one
 * directory, and a rule that only tidies `..` and `.` reads them as two places; a teardown then
 * runs against the real volume through the alias. A path whose identity cannot be resolved is
 * refused rather than assumed distinct.
 */

export type SubstrateTarget = {
  readonly graphUri: string;
  /** `:memory:` is the one non-file value, and it is disposable by construction. */
  readonly sqlitePath: string;
};

export const IN_MEMORY_SQLITE = ':memory:';

export type TargetDeclaration =
  | {
      /**
       * A container this run started and will remove. The name alone proves nothing: a string
       * read out of the environment names a container somebody else is using, so the caller
       * states outright that it created this one.
       */
      readonly kind: 'harness';
      readonly containerName: string;
      readonly createdByThisRun: boolean;
    }
  | {
      /** A copy somebody made, whose endpoint and data root the caller states outright. */
      readonly kind: 'declared_clone';
      readonly verifiedGraphUri: string;
      readonly verifiedSqlitePath: string;
    };

export const ISOLATION_REJECTIONS = [
  'undeclared_target',
  'production_graph_endpoint',
  'production_data_root',
  'unverified_target',
] as const;

export type IsolationRejection = (typeof ISOLATION_REJECTIONS)[number];

export type IsolationVerdict =
  | { readonly status: 'isolated'; readonly basis: 'harness_created' | 'verified_clone' }
  | {
      readonly status: 'rejected';
      readonly reason: IsolationRejection;
      readonly detail: string;
    };

/**
 * A server is a host and a port. The scheme is a driver setting: `bolt`, `neo4j`, and their
 * TLS spellings all reach the same server, so a scheme in the comparison would let one alias
 * pass as a different machine. Loopback spellings fold together and the default bolt port is
 * made explicit for the same reason. Folding in the permissive direction on purpose:
 * over-matching refuses a run, and under-matching runs a teardown against the live substrate.
 */
export function normalizeEndpoint(uri: string): string {
  const trimmed = uri.trim().toLowerCase().replace(/\/+$/, '');
  const authority = /^(?:[a-z0-9+.-]+:\/\/)?([^/?#]+)/.exec(trimmed)?.[1];
  if (authority === undefined || authority.length === 0) {
    return trimmed;
  }
  const withPort = /:\d+$/.test(authority) ? authority : `${authority}:7687`;
  return withPort.replace(/^(localhost|127\.0\.0\.1|\[::1\]|::1|0\.0\.0\.0):/, 'localhost:');
}

/** Resolves one path through the filesystem, or says why it could not. */
export type LinkResolver = (path: string) => string;

/**
 * The path with every symlink on it resolved, by the filesystem's own traversal.
 *
 * The raw path goes to the resolver untouched. Tidying `..` first is not the same operation:
 * `clone/link/../aion.sqlite` where `link` points elsewhere resolves, on the filesystem, into
 * the directory the link names, and a syntactic tidy answers `clone/aion.sqlite` instead. Two
 * different files, and the wrong one admitted.
 *
 * A target that does not exist yet is resolved through the nearest ancestor that does, and only
 * the components genuinely absent below it are rejoined. Absence is the one condition that
 * climbs: a loop, a permission refusal or anything else is an identity nobody resolved, and
 * appending components to a parent reached that way invents one.
 */
export function canonicalPath(path: string, resolveLink?: LinkResolver): string | undefined {
  const resolver = resolveLink ?? ((candidate: string) => realpathSync.native(candidate));
  if (path === IN_MEMORY_SQLITE) {
    return path;
  }
  if (!isAbsolute(path)) {
    return undefined;
  }

  const absent: string[] = [];
  let head = path;
  for (;;) {
    try {
      return [resolver(head), ...absent].join(sep);
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') {
        return undefined;
      }
      const parent = dirname(head);
      if (parent === head) {
        return undefined;
      }
      // `basename` rather than a slice: the component may be `..`, which is a real step the
      // parent's own resolution has to make.
      absent.unshift(basename(head));
      head = parent;
    }
  }
}

export type DataRootVerdict = 'distinct' | 'overlapping' | 'unresolvable';

/**
 * Overlap in either direction, on filesystem identity. A rehearsal file beside the running one
 * is refused, and so is a running file beside a rehearsal directory: both mean a teardown
 * reaches bytes somebody else owns.
 */
export function dataRootVerdict(
  target: string,
  production: string,
  resolveLink?: LinkResolver,
): DataRootVerdict {
  if (target === IN_MEMORY_SQLITE || production === IN_MEMORY_SQLITE) {
    return 'distinct';
  }
  const targetPath = canonicalPath(target, resolveLink);
  const productionPath = canonicalPath(production, resolveLink);
  if (targetPath === undefined || productionPath === undefined) {
    return 'unresolvable';
  }
  if (targetPath === productionPath) {
    return 'overlapping';
  }
  const overlapping =
    contains(dirname(productionPath), targetPath) || contains(dirname(targetPath), productionPath);
  return overlapping ? 'overlapping' : 'distinct';
}

/** Kept for callers asking the yes-or-no question; an unresolvable identity counts as overlap. */
export function sharesDataRoot(target: string, production: string): boolean {
  return dataRootVerdict(target, production) !== 'distinct';
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export type RehearsalCheck = {
  readonly target: SubstrateTarget;
  /** The substrate the service runs on, which is what the target must not be. */
  readonly production: SubstrateTarget;
  readonly declaration?: TargetDeclaration;
};

export function checkRehearsalTarget(input: RehearsalCheck): IsolationVerdict {
  const { target, production, declaration } = input;
  if (declaration === undefined) {
    return {
      status: 'rejected',
      reason: 'undeclared_target',
      detail: 'no caller stated what this substrate is',
    };
  }
  if (normalizeEndpoint(target.graphUri) === normalizeEndpoint(production.graphUri)) {
    return {
      status: 'rejected',
      reason: 'production_graph_endpoint',
      detail: 'the target resolves to the running graph endpoint',
    };
  }
  const roots = dataRootVerdict(target.sqlitePath, production.sqlitePath);
  if (roots === 'overlapping') {
    return {
      status: 'rejected',
      reason: 'production_data_root',
      detail: 'the target file resolves into the running substrate data directory',
    };
  }
  if (roots === 'unresolvable') {
    return {
      status: 'rejected',
      reason: 'unverified_target',
      detail: 'the target path resolves to no filesystem identity anything can vouch for',
    };
  }
  if (declaration.kind === 'harness') {
    if (declaration.containerName.trim().length === 0 || !declaration.createdByThisRun) {
      return {
        status: 'rejected',
        reason: 'unverified_target',
        detail: 'nothing states that this run created the container it is about to use',
      };
    }
    return { status: 'isolated', basis: 'harness_created' };
  }
  const declaredPath = canonicalPath(declaration.verifiedSqlitePath);
  if (
    normalizeEndpoint(declaration.verifiedGraphUri) !== normalizeEndpoint(target.graphUri) ||
    declaredPath === undefined ||
    declaredPath !== canonicalPath(target.sqlitePath)
  ) {
    return {
      status: 'rejected',
      reason: 'unverified_target',
      detail: 'the declared clone identity does not match the substrate being connected to',
    };
  }
  return { status: 'isolated', basis: 'verified_clone' };
}
