import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { reopenSourceWork } from '../../infrastructure/sqlite/generation-lifecycle.js';
import { readActiveGeneration } from '../../infrastructure/sqlite/processing-generations.js';
import {
  readGenerationWork,
  type StageWorkDetail,
} from '../../infrastructure/sqlite/source-readiness.js';
import {
  committedForget,
  hasPendingSourceState,
} from '../../infrastructure/sqlite/source-state-versions.js';
import { ContinuationEffectSchema } from '../domain/continuation-schema.js';
import type { StageSettlement } from '../domain/stage.js';

/**
 * The signed forget disposition and its reversal, in one place.
 *
 * A forget closes the passes that had nothing left to act on, and withdrawing the forget owes them
 * again. Both halves classify on the same effect and recognise each other's rows by the same
 * reason, so they live together rather than inside the settlement that happens to call one of them.
 */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What the disposition writes as its reason, and what a reopen recognises it by. */
const FORGET_DISPOSITION_REASON = 'source_forgotten';

/** The reason a reopened row carries, so the record says which statement stopped holding. */
export const WITHDRAWN_FORGET_REASON = 'the forget this row rested on was withdrawn';

/** One rule for what the disposition closed, asked by the settlement and by the unforget writer. */
function rowRestedOnForget(row: { readonly outcome?: { readonly reason: string } }): boolean {
  return row.outcome?.reason === FORGET_DISPOSITION_REASON;
}

/**
 * The signed forget disposition, applied to what the run left owed.
 *
 * A forgotten source's generative passes have nothing left to act on, so their rows close as not
 * applicable with the acknowledged statement as proof. Settlement and indexing obligations are
 * untouched: those are owed whatever became of the content. It is reversible in the same place,
 * because an unforget withdraws the statement the disposition rested on and the rows it closed
 * are owed again.
 *
 * A statement prepared and not yet acknowledged decides nothing either way. The answer is about
 * to move and nothing here can say which way.
 */
export function applyForgetDisposition(
  db: SqliteHandle,
  sourceId: string,
  processingGeneration: number,
  now: Date,
  close: (stageName: string, settlement: StageSettlement) => void,
  work: {
    readonly detail: ReadonlyMap<string, StageWorkDetail>;
    readonly requiredStages: readonly string[] | undefined;
  },
): void {
  if (hasPendingSourceState(db, sourceId)) {
    return;
  }
  const forget = committedForget(db, sourceId);
  for (const row of readGenerationWork(db, sourceId, processingGeneration)) {
    const { stageName } = row;
    if (row.kind !== 'stage' || stageName === null || row.state === 'obsolete') {
      continue;
    }
    // The effect decides, not the container, and it is classified positively from the row's own
    // declaration or the accepted contract. A row that owes consistency work on RETAINED
    // endpoints, and a row whose effect nothing classifies, are both left alone: forgetting the
    // source does not make another node's neighbourhood correct.
    if (!forgetDisposesOf(stageName, work.requiredStages, work.detail.get(stageName))) {
      continue;
    }
    if (forget !== undefined && row.state !== 'completed') {
      close(stageName, {
        disposition: 'not_applicable',
        reason: FORGET_DISPOSITION_REASON,
        proof: { stateVersion: forget.version, knownFrom: forget.knownFrom },
      });
      continue;
    }
    if (forget === undefined && rowRestedOnForget(row)) {
      reopenSourceWork(db, row.workId, WITHDRAWN_FORGET_REASON, now);
    }
  }
}

/**
 * Re-owes everything a withdrawn forget had closed, for one source.
 *
 * The settlement reverses its own disposition when a run happens to pass over the source again.
 * That is too late to be the only path: between an unforget and the next run, the rows read
 * completed, nothing reports an obligation, and the source can reach eviction with the passes
 * never performed. So the writer that withdraws the statement re-owes the work in the same
 * operation, and a run arriving later finds it already owed.
 *
 * Returns how many rows were re-owed. Zero is the ordinary answer: most unforgotten sources never
 * had a run settle over them while they were forgotten.
 */
export function reopenWorkAWithdrawnForgetClosed(
  db: SqliteHandle,
  sourceId: string,
  now: Date,
): number {
  const generation = readActiveGeneration(db, sourceId);
  if (generation === undefined) {
    return 0;
  }
  let reopened = 0;
  for (const row of readGenerationWork(db, sourceId, generation.processingGeneration)) {
    if (row.state !== 'completed' || !rowRestedOnForget(row)) {
      continue;
    }
    if (reopenSourceWork(db, row.workId, WITHDRAWN_FORGET_REASON, now) !== undefined) {
      reopened += 1;
    }
  }
  return reopened;
}

/**
 * What a stage's remaining work would DO, which is what the forget ruling classifies on.
 *
 * `source_generation` is generative use of the source's own content, and a forgotten source
 * leaves it nothing to act on. `retained_endpoint` is consistency work about OTHER nodes, which
 * is owed whatever became of this source.
 */
type StageEffect = 'source_generation' | 'retained_endpoint';

/**
 * Effects a row's continuation may declare, and what each one is about.
 *
 * A closed set, declared where it is read. An effect this build does not register is
 * unclassified: the row said what it is carrying and nothing here knows what that is.
 */
const DECLARED_EFFECTS: Readonly<Record<string, StageEffect>> = {
  retained_endpoint_vector: 'retained_endpoint',
  source_dependent_generation: 'source_generation',
};

/**
 * What each stage the accepted contract lists does with the source it runs on.
 *
 * Extraction, the bounded nomination passes and the relation passes are generative use of the
 * source. The stages that are absent are absent on purpose: a reinforcement flush and a context
 * vector recompute act on retained endpoints, the narrative dispatch belongs to a coverage
 * revision, and none of that stops being owed because this source was forgotten. A stage name
 * nothing here classifies is unclassified for the same reason a row is: nobody said what its
 * pass does, and absence of a classification is not proof the work vanished with the source.
 */
const CONTRACT_STAGE_EFFECTS: Readonly<Record<string, StageEffect>> = {
  entities: 'source_generation',
  cognitive: 'source_generation',
  'entity-dedup': 'source_generation',
  associations: 'source_generation',
  'semantic-relationships': 'source_generation',
  supersession: 'source_generation',
};

/**
 * What the row says its remaining work is, or nothing when it says nothing about its effect.
 *
 * A continuation that is a transfer or a withheld remainder declares no effect and answers
 * nothing here; the accepted contract classifies those rows instead.
 */
function declaredEffect(
  row: StageWorkDetail | undefined,
): StageEffect | 'unclassified' | undefined {
  if (row?.continuationJson == null) {
    return undefined;
  }
  const parsed = ContinuationEffectSchema.safeParse(parseJson(row.continuationJson));
  if (!parsed.success) {
    return undefined;
  }
  return DECLARED_EFFECTS[parsed.data.effect] ?? 'unclassified';
}

/**
 * Whether a forget disposes of this row, classified positively by effect.
 *
 * Two places an effect can come from, and both name one: the row's own validated declaration,
 * or the accepted contract's classification of a stage that contract required. Everything else
 * is unclassified — a declared effect this build does not register, a row some other pass added,
 * a stage no table accounts for — and unclassified is not a licence to close it. The row stays
 * owed, pinned to somebody who can decide it, because closing it here would leave retained
 * endpoints holding a reading nobody will recompute.
 */
function forgetDisposesOf(
  stageName: string,
  requiredStages: readonly string[] | undefined,
  row: StageWorkDetail | undefined,
): boolean {
  const declared = declaredEffect(row);
  if (declared !== undefined) {
    return declared === 'source_generation';
  }
  return (
    requiredStages?.includes(stageName) === true &&
    CONTRACT_STAGE_EFFECTS[stageName] === 'source_generation'
  );
}
