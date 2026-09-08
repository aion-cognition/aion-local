import { dirname, isAbsolute, normalize, sep } from 'node:path';

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
 */

export type SubstrateTarget = {
  readonly graphUri: string;
  /** `:memory:` is the one non-file value, and it is disposable by construction. */
  readonly sqlitePath: string;
};

export const IN_MEMORY_SQLITE = ':memory:';

export type TargetDeclaration =
  | {
      /** A container this run started and will remove. */
      readonly kind: 'harness';
      readonly containerName: string;
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
 * Loopback spellings are folded together and the default bolt port is made explicit, so a
 * target written one way and production written another are still recognised as the same
 * server. Folding in the permissive direction on purpose: over-matching refuses a run, and
 * under-matching runs a teardown against the live substrate.
 */
function normalizeEndpoint(uri: string): string {
  const trimmed = uri.trim().toLowerCase().replace(/\/+$/, '');
  const match = /^([a-z0-9+.-]+):\/\/([^/?#]+)(.*)$/.exec(trimmed);
  if (match === null) {
    return trimmed;
  }
  const [, scheme, authority, rest] = match;
  if (scheme === undefined || authority === undefined) {
    return trimmed;
  }
  const withPort = authority.includes(':') ? authority : `${authority}:7687`;
  const host = withPort.replace(/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):/, 'localhost:');
  return `${scheme}://${host}${rest ?? ''}`;
}

function sharesDataRoot(target: string, production: string): boolean {
  if (target === IN_MEMORY_SQLITE || production === IN_MEMORY_SQLITE) {
    return false;
  }
  if (!isAbsolute(target) || !isAbsolute(production)) {
    return true;
  }
  const targetPath = normalize(target);
  const productionPath = normalize(production);
  if (targetPath === productionPath) {
    return true;
  }
  const root = dirname(productionPath);
  return targetPath === root || targetPath.startsWith(`${root}${sep}`);
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
  if (sharesDataRoot(target.sqlitePath, production.sqlitePath)) {
    return {
      status: 'rejected',
      reason: 'production_data_root',
      detail: 'the target file sits in the running substrate data directory',
    };
  }
  if (declaration.kind === 'harness') {
    if (declaration.containerName.trim().length === 0) {
      return {
        status: 'rejected',
        reason: 'unverified_target',
        detail: 'the harness declaration names no container',
      };
    }
    return { status: 'isolated', basis: 'harness_created' };
  }
  if (
    normalizeEndpoint(declaration.verifiedGraphUri) !== normalizeEndpoint(target.graphUri) ||
    normalize(declaration.verifiedSqlitePath) !== normalize(target.sqlitePath)
  ) {
    return {
      status: 'rejected',
      reason: 'unverified_target',
      detail: 'the declared clone identity does not match the substrate being connected to',
    };
  }
  return { status: 'isolated', basis: 'verified_clone' };
}
