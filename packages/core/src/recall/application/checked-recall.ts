import {
  RecallInputSchema,
  type CoverageRefusal,
  type MemoryPack,
  type RecallResult,
} from '@aion/protocol';

import { checkCoverage, type CheckedRead } from './coverage-checker.js';
import { refusalLines } from './coverage-text.js';
import {
  completeCheckedRead,
  withoutPosition,
  type CheckedReadOutcome,
  type ReadCoordinator,
} from './read-completion.js';
import { handleRecall, type RecallDeps } from './recall.js';
import type { CommitDisposition, ServingEffects } from './serving-effects.js';
import { EvidenceResolver } from '../../evidence/application/resolver.js';

/**
 * Recall as a covered entry point: the coverage decision, the publication position, the
 * pipeline, and the one boundary its effects commit at.
 *
 * The order is the contract. Coverage is decided before a session is resolved, before a
 * provider is called and before a served row is deleted, so a refused request costs nothing
 * and takes nothing away. The answer is then computed under that one decision, and the writes
 * a successful read makes go through the shared completion boundary, which checks the contract
 * again inside the transaction that commits them.
 */

export type CheckedRecallDeps = RecallDeps & {
  /** Required here, unlike the pipeline's own optional field: a checked read reads certified. */
  readonly resolver: EvidenceResolver;
  readonly coordinator: ReadCoordinator;
};

/**
 * The deps a covered recall takes, built where the resolver lives so a transport never
 * constructs a second one. One resolver for the process, like the archive reads' own.
 */
export function checkedRecallDeps(
  deps: RecallDeps & { readonly coordinator: ReadCoordinator },
): CheckedRecallDeps {
  return {
    ...deps,
    resolver: new EvidenceResolver({ driver: deps.driver, db: deps.db, logger: deps.logger }),
  };
}

export type CheckedRecallOptions = {
  /** The transport's session identity. `session_id` in the payload overrides it. */
  readonly identity: string;
  readonly now?: Date;
};

/**
 * What the caller receives. `withheld` says the answer was served but nothing about it was
 * recorded: no served rows, no last pack, no counters, and no requested delivery reset. The
 * pack says so too, in its coverage statement, so a caller reading only the answer learns it.
 */
export type CheckedRecallOutcome =
  | {
      readonly status: 'pack';
      readonly pack: MemoryPack;
      readonly effects: 'persisted' | 'withheld';
    }
  | { readonly status: 'coverage_refusal'; readonly refusal: CoverageRefusal };

export async function runCheckedRecall(
  deps: CheckedRecallDeps,
  input: unknown,
  options: CheckedRecallOptions,
): Promise<CheckedRecallOutcome> {
  const payload = RecallInputSchema.parse(input);
  // One clock for the whole request: the checker judges against it and the pipeline reads it
  // back off the checked context rather than taking its own.
  const now = options.now ?? new Date();
  const check = checkCoverage(deps.db, {
    ...(payload.as_of === undefined ? {} : { asOf: payload.as_of }),
    ...(payload.knew_at === undefined ? {} : { knewAt: payload.knew_at }),
    now,
    expiryAnnotation: deps.config.temporal.expiryAnnotation,
  });
  if (check.status === 'refused') {
    return { status: 'coverage_refusal', refusal: check.refusal };
  }
  const read: CheckedRead = { context: check.context, coverage: check.coverage };

  // Taken before the work starts and held through it, so the boundary can tell a substrate that
  // moved under this read from one that did not.
  const position = await deps.coordinator.checkpoint();
  let settled: CheckedReadOutcome<unknown> | undefined;
  const commit = async (effects: ServingEffects): Promise<CommitDisposition> => {
    settled =
      position.status === 'ready'
        ? await completeCheckedRead<unknown>(
            { coordinator: deps.coordinator, db: deps.db },
            {
              read,
              checkpoint: position.checkpoint,
              ...(effects.resetDelivery === undefined
                ? {}
                : { resetDelivery: effects.resetDelivery }),
              persist: effects.persist,
            },
          )
        : withoutPosition<unknown>(deps.db, read, position.reason);
    if (settled.status === 'refused') {
      return 'withheld';
    }
    // The pipeline attaches the disclosure, because it holds the one statement the answer
    // carries and this boundary has no second place to put it.
    return settled.status === 'completed' ? 'served' : 'degraded';
  };

  const pack = await handleRecall(deps, payload, {
    identity: options.identity,
    now,
    checked: read,
    commit,
  });
  const outcome = settled;
  if (outcome === undefined) {
    throw new Error('recall returned without reaching its completion boundary');
  }
  if (outcome.status === 'refused') {
    return { status: 'coverage_refusal', refusal: outcome.refusal };
  }
  if (outcome.status === 'completed') {
    return { status: 'pack', pack, effects: 'persisted' };
  }
  deps.logger.info(
    { reason: outcome.reason, sessionId: payload.session_id ?? options.identity },
    'recall served without recording its effects',
  );
  return { status: 'pack', pack, effects: 'withheld' };
}

/**
 * The crossing to the wire. A refusal is a branch of its own rather than an empty pack, and the
 * successful shape is the pack it has always been.
 */
export function recallResultFor(outcome: CheckedRecallOutcome): RecallResult {
  return outcome.status === 'pack'
    ? outcome.pack
    : { status: 'coverage_refusal', coverage_refusal: outcome.refusal };
}

/**
 * The rendered block beside it. A refusal reads as a refusal in text too: a client that renders
 * only the block would otherwise be told nothing was found.
 */
export function recallText(result: RecallResult): string {
  return 'status' in result
    ? refusalLines(result.coverage_refusal).join('\n')
    : result.rendered_text;
}
