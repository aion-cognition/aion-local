import type { RevisionCheck } from './dependencies.js';
import type { JudgmentAssembly, JudgmentEvidence, JudgmentPair } from './judgment.js';
import type { EvidenceResolver } from './resolver.js';
import {
  buildEvidenceRevision,
  type EvidenceRevision,
} from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { checkPresentCoverage } from '../../recall/application/coverage-checker.js';
import { idAddress } from '../domain/address.js';

/**
 * The evidence seam for the two entry points that judge without a request behind them.
 *
 * A recall holds one checked context for the whole request and hands it down. The maintenance
 * loop and the reflection pipeline have no request: they run for hours, and a context built once
 * at composition would pin every judgment they ever make to the coverage contract that stood at
 * startup. So coverage is checked per pair, against the clock the judgment is being made on, and
 * the vantage the seam carries is the one that was in force when the judge was asked.
 *
 * An unreadable coverage record refuses rather than judging. That is the same answer a covered
 * read gives: a substrate that cannot say what its answers cover cannot certify a destructive
 * one either, and the pair stays owed with the reason on it.
 */
export class CoveredJudgmentEvidence implements JudgmentEvidence {
  readonly #db: SqliteHandle;
  readonly #resolver: EvidenceResolver;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: SqliteHandle;
    readonly resolver: EvidenceResolver;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#resolver = options.resolver;
    this.#now = options.now ?? ((): Date => new Date());
  }

  async assemble(pair: JudgmentPair): Promise<JudgmentAssembly> {
    const check = checkPresentCoverage(this.#db, this.#now());
    if (check.status === 'refused') {
      return {
        status: 'incomplete',
        reasons: pair.sides.map((side) => ({
          address: idAddress(side.nodeId),
          field: 'interpretation_text' as const,
          reason: 'store_unavailable' as const,
          required: true,
        })),
        revision: emptyRevision(),
      };
    }
    const assembly = await this.#resolver.assembleJudgment(pair, check.context);
    // The vantage the judgment was made under travels with it. Everything downstream re-reads the
    // substrate to decide whether the decision still holds, and the one thing it cannot re-read is
    // what the decision was taken under.
    return assembly.status === 'assembled'
      ? { ...assembly, coverageEpoch: check.context.coverageEpoch }
      : assembly;
  }

  confirm(revision: EvidenceRevision): RevisionCheck {
    return this.#resolver.confirm(revision);
  }
}

/** A refusal rests on nothing, and a revision that claimed dependencies would say it did. */
function emptyRevision(): EvidenceRevision {
  return buildEvidenceRevision([]);
}
