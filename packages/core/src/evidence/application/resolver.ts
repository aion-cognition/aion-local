import type { Driver } from 'neo4j-driver';

import {
  EvidenceDependencies,
  verifyEvidenceRevision,
  type RevisionCheck,
} from './dependencies.js';
import {
  assembleJudgmentEvidence,
  type JudgmentAssembly,
  type JudgmentEvidence,
  type JudgmentPair,
} from './judgment.js';
import { readItemMetadata, type ItemMetadata } from './metadata.js';
import { resolveSourceEvidence, type SourceEvidence } from './sources.js';
import { readClaimSubjects } from './subjects.js';
import type { ClaimSubject } from '../../infrastructure/graph/subject-family.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { EvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import type {
  CheckpointResult,
  PublicationCheckpoint,
} from '../../infrastructure/publication/types.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { evidenceRequestKey, type EvidenceAddress } from '../domain/address.js';
import { EVIDENCE_LIMITS, RequestBudget, type EvidenceLimits } from '../domain/budget.js';
import {
  evidenceResult,
  type EvidenceIssue,
  type EvidenceResult,
  type EvidenceUse,
} from '../domain/result.js';

/**
 * The one source read behind serving, inspection, narrative input and judgment.
 *
 * Every requested address gets a result: an omitted map entry would leave a caller to decide for
 * itself what the silence meant, and the whole point of the four dimensions is that the answer
 * says so. Certification happens here rather than at nomination, and a pending publication
 * degrades a read instead of blocking it, while a destructive judgment refuses to certify on the
 * same state.
 */

/** The coordinator surface a read holds a position against. */
export type EvidenceCheckpointReader = {
  checkpoint(): Promise<CheckpointResult>;
};

export type EvidenceResolverOptions = {
  readonly driver: Driver;
  readonly db: SqliteHandle;
  readonly logger: Pick<Logger, 'warn'>;
  readonly limits?: EvidenceLimits;
  /**
   * The publication position a read is certified against. Without it a read still answers, and
   * a judgment does not: an uncertified judgment is exactly the write that races a publication.
   */
  readonly publications?: EvidenceCheckpointReader;
};

export type EvidenceBatch<T> = {
  readonly results: ReadonlyMap<string, EvidenceResult<T>>;
  /** Every issue the run named, required and optional alike, for the coverage statement. */
  readonly issues: readonly EvidenceIssue[];
  readonly revision: EvidenceRevision;
};

type Certification =
  /** A position was taken, or none was asked for because no coordinator was supplied. */
  | { readonly status: 'certified'; readonly checkpoint?: PublicationCheckpoint }
  /** No position could be taken. The reason says which, and neither one certifies anything. */
  | {
      readonly status: 'uncertified';
      readonly reason: string;
      readonly issue: 'pending_publication' | 'budget_limit';
    };

function uncertifiedIssue(
  address: EvidenceAddress,
  reason: 'pending_publication' | 'budget_limit',
  required: boolean,
): EvidenceIssue {
  return { address, field: 'interpretation_text', reason, required };
}

export class EvidenceResolver {
  readonly #options: EvidenceResolverOptions;
  readonly #limits: EvidenceLimits;

  constructor(options: EvidenceResolverOptions) {
    this.#options = options;
    this.#limits = options.limits ?? EVIDENCE_LIMITS;
  }

  /** One allowance per request, spent by every subread that request makes. */
  newBudget(): RequestBudget {
    return new RequestBudget(this.#limits);
  }

  async resolveMetadata(
    ids: readonly string[],
    context: CheckedReadContext,
    options: { readonly maxRoots: number; readonly budget?: RequestBudget },
  ): Promise<EvidenceBatch<ItemMetadata>> {
    const budget = options.budget ?? this.newBudget();
    const before = await this.#certify(budget);
    const reading = await readItemMetadata(
      { driver: this.#options.driver, db: this.#options.db },
      { ids, context, budget, maxRoots: options.maxRoots },
    );
    const dependencies = new EvidenceDependencies();
    dependencies.addAll(reading.dependencies);
    const drift = await this.#recheck(budget, before);
    const results = new Map(reading.results);
    const issues = [...reading.issues];
    if (drift !== undefined) {
      for (const [key, result] of results) {
        const issue = uncertifiedIssue(result.address, drift, true);
        issues.push(issue);
        results.set(
          key,
          evidenceResult({
            address: result.address,
            residency: result.residency,
            issues: [...(readIssues(result) ?? []), issue],
            ...(result.value === undefined ? {} : { value: result.value }),
          }),
        );
      }
    }
    return { results, issues, revision: dependencies.revision() };
  }

  /**
   * Verified raw parts for each address. Suppression is applied for every purpose a caller can
   * name; indexing reads past it, and every path that discloses a hit checks it again.
   */
  async resolveSources(
    addresses: readonly EvidenceAddress[],
    context: CheckedReadContext,
    use: EvidenceUse,
    options: { readonly required?: boolean; readonly budget?: RequestBudget } = {},
  ): Promise<EvidenceBatch<SourceEvidence>> {
    const budget = options.budget ?? this.newBudget();
    const required = options.required ?? true;
    const before = await this.#certify(budget);
    const results = new Map<string, EvidenceResult<SourceEvidence>>();
    const issues: EvidenceIssue[] = [];
    const dependencies = new EvidenceDependencies();

    for (const address of addresses) {
      const overflow = budget.chargeIds(1);
      if (overflow !== undefined) {
        const issue: EvidenceIssue = {
          address,
          field: 'source_content',
          reason: 'budget_limit',
          required,
        };
        issues.push(issue);
        results.set(
          evidenceRequestKey(address),
          evidenceResult({ address, residency: 'unknown-mapping', issues: [issue] }),
        );
        continue;
      }
      const resolution = this.#readSource(address, { use, context, budget, required });
      dependencies.addAll(resolution.dependencies);
      issues.push(...resolution.issues);
      results.set(
        evidenceRequestKey(address),
        evidenceResult({
          address,
          residency: resolution.residency,
          issues: resolution.issues,
          ...(resolution.value === undefined ? {} : { value: resolution.value }),
        }),
      );
    }

    const drift = await this.#recheck(budget, before);
    if (drift !== undefined) {
      for (const [key, result] of results) {
        // Raw bytes carry their own proof: the archive digest and the recorded mapping are
        // immutable, so a publication in flight is disclosed against a verified reading rather
        // than withheld from it. Anything the reading could not verify stays blocked.
        const verified =
          result.evidence.status === 'complete-for-use' && result.value !== undefined;
        const issue = uncertifiedIssue(result.address, drift, required && !verified);
        issues.push(issue);
        results.set(
          key,
          evidenceResult({
            address: result.address,
            residency: result.residency,
            issues: [...(readIssues(result) ?? []), issue],
            ...(result.value === undefined ? {} : { value: result.value }),
          }),
        );
      }
    }
    return { results, issues, revision: dependencies.revision() };
  }

  /**
   * Which entities each claim names. Certified like every other surface: the subject join reads
   * retained state, so a position in flight is what says whether the join it walked still holds.
   */
  async resolveSubjects(
    claimIds: readonly string[],
    context: CheckedReadContext,
    options: { readonly budget?: RequestBudget } = {},
  ): Promise<EvidenceBatch<readonly ClaimSubject[]>> {
    const budget = options.budget ?? this.newBudget();
    const before = await this.#certify(budget);
    const reading = await readClaimSubjects(
      { driver: this.#options.driver, db: this.#options.db },
      { claimIds, context, budget },
    );
    const dependencies = new EvidenceDependencies();
    dependencies.addAll(reading.dependencies);
    const drift = await this.#recheck(budget, before);
    if (drift === undefined) {
      return {
        results: reading.results,
        issues: reading.issues,
        revision: dependencies.revision(),
      };
    }
    const results = new Map(reading.results);
    const issues = [...reading.issues];
    for (const [key, result] of results) {
      const issue = uncertifiedIssue(result.address, drift, true);
      issues.push(issue);
      results.set(
        key,
        evidenceResult({
          address: result.address,
          residency: result.residency,
          issues: [...(readIssues(result) ?? []), issue],
          ...(result.value === undefined ? {} : { value: result.value }),
        }),
      );
    }
    return { results, issues, revision: dependencies.revision() };
  }

  /**
   * The two statements, their required sources, and one dependency revision for both sides.
   *
   * A judgment is certified against the publication position or it is not assembled at all. A
   * read may degrade under a pending publication; a destructive judgment may not, because the
   * write it leads to would land on evidence nobody could certify.
   */
  async assembleJudgment(
    pair: JudgmentPair,
    context: CheckedReadContext,
    budget: RequestBudget = this.newBudget(),
  ): Promise<JudgmentAssembly> {
    const before = await this.#certify(budget);
    if (before.status === 'uncertified' || before.checkpoint === undefined) {
      return {
        status: 'incomplete',
        reasons: pair.sides.map((side) => ({
          address: { kind: 'id' as const, id: side.nodeId },
          field: 'source_content' as const,
          reason:
            before.status === 'uncertified' ? before.issue : ('required_scope_missing' as const),
          required: true,
        })),
        revision: new EvidenceDependencies().revision(),
      };
    }
    const assembly = await assembleJudgmentEvidence(
      { driver: this.#options.driver, db: this.#options.db },
      pair,
      context,
      budget,
    );
    const drift = await this.#recheck(budget, before);
    if (drift === undefined || assembly.status !== 'assembled') {
      return assembly;
    }
    return {
      status: 'incomplete',
      reasons: pair.sides.map((side) => ({
        address: { kind: 'id' as const, id: side.nodeId },
        field: 'source_content' as const,
        reason: drift,
        required: true,
      })),
      revision: assembly.revision,
    };
  }

  /** Whether a stored revision still describes the substrate, before a decision is applied. */
  confirm(revision: EvidenceRevision): RevisionCheck {
    return verifyEvidenceRevision(this.#options.db, revision);
  }

  #readSource(
    address: EvidenceAddress,
    request: {
      readonly use: EvidenceUse;
      readonly context: CheckedReadContext;
      readonly budget: RequestBudget;
      readonly required: boolean;
    },
  ): ReturnType<typeof resolveSourceEvidence> {
    try {
      return resolveSourceEvidence(this.#options.db, address, request);
    } catch (err) {
      this.#options.logger.warn({ err }, 'source evidence read failed');
      return {
        residency: 'unknown-mapping',
        issues: [
          {
            address,
            field: 'source_content',
            reason: 'store_unavailable',
            required: request.required,
          },
        ],
        dependencies: [],
      };
    }
  }

  /**
   * The position the read is judged against, taken once and rechecked once.
   *
   * An exhausted allowance is not a position. Returning one would let a request that spent its
   * checkpoint reads certify on nothing, which is the failure a bound exists to prevent.
   */
  async #certify(budget: RequestBudget): Promise<Certification> {
    const { publications } = this.#options;
    if (publications === undefined) {
      return { status: 'certified' };
    }
    if (budget.takeCheckpointAttempt() !== undefined) {
      return {
        status: 'uncertified',
        reason: 'checkpoint_budget_exhausted',
        issue: 'budget_limit',
      };
    }
    const result = await publications.checkpoint();
    return result.status === 'ready'
      ? { status: 'certified', checkpoint: result.checkpoint }
      : { status: 'uncertified', reason: result.reason, issue: 'pending_publication' };
  }

  /** What stopped the view being coherent, or nothing when the position held. */
  async #recheck(
    budget: RequestBudget,
    before: Certification,
  ): Promise<'pending_publication' | 'budget_limit' | undefined> {
    if (before.status === 'uncertified') {
      return before.issue;
    }
    const taken = before.checkpoint;
    if (taken === undefined) {
      return undefined;
    }
    const after = await this.#certify(budget);
    if (after.status === 'uncertified') {
      return after.issue;
    }
    // A second reading that names no position proves nothing about the first, so the answer is
    // treated as one read under a position that may have moved.
    return after.checkpoint?.sequence === taken.sequence ? undefined : 'pending_publication';
  }
}

/** The issues a result already carries, so a later one is added rather than replacing them. */
function readIssues(result: EvidenceResult<unknown>): readonly EvidenceIssue[] | undefined {
  return result.evidence.status === 'complete-for-use' ? [] : result.evidence.reasons;
}

/**
 * One checked context bound to the resolver, which is what a judgment path holds. The path never
 * builds a vantage of its own: the entry point that checked coverage builds this and hands it on.
 */
export class CheckedJudgmentEvidence implements JudgmentEvidence {
  readonly #resolver: EvidenceResolver;
  readonly #context: CheckedReadContext;

  constructor(options: {
    readonly resolver: EvidenceResolver;
    readonly context: CheckedReadContext;
  }) {
    this.#resolver = options.resolver;
    this.#context = options.context;
  }

  async assemble(pair: JudgmentPair): Promise<JudgmentAssembly> {
    return this.#resolver.assembleJudgment(pair, this.#context);
  }

  confirm(revision: EvidenceRevision): RevisionCheck {
    return this.#resolver.confirm(revision);
  }
}
