import { createHash } from 'node:crypto';

import { QUALITY_FIXTURES, type QualityFixture } from './fixtures.js';
import {
  extractCognitiveViaProvider,
  extractEntitiesViaProvider,
  type ProviderGenerateDeps,
} from './provider-extractor.js';
import type { ExtractionFailure } from './types.js';
import type { FrameOverride } from '../../../infrastructure/providers/request-blocks.js';
import {
  CAMPAIGN_CONDITIONS,
  type CampaignCondition,
  type CampaignProducerHandle,
} from '../../../infrastructure/providers/test-support/campaign-guard.js';
import type { ApiCall } from '../../../infrastructure/providers/types.js';
import { renderEpisodeText } from '../../domain/content.js';

/**
 * The extraction-faithfulness experiment's one execution and recording path.
 *
 * The live root and the injected rehearsal both run this, so the rehearsal proves the path the
 * live run takes rather than a parallel one written to look like it. What it retains is what the
 * experiment's question needs and what a metrics summary destroys: the values each extractor
 * actually returned, the fixture they were returned from, the condition and extractor identity
 * that produced them. Extracting "Redis" from a Redis fixture and inventing a product name
 * reduce to the same counts, the same type histogram and the same schema validity; they do not
 * reduce to the same retained record here.
 *
 * Execution and validity are two questions, kept apart. A case the spending guard turned back
 * before its first request left was never asked, and recording it beside a malformed model
 * answer reports a failure the model never had the chance to commit. The guard's refusal arrives
 * typed from the call boundary (`ExtractorOutcome.failure`), never read out of an error sentence.
 *
 * A refusal is not always that clean, though: the constrained JSON retry inside one structured
 * call is a second physical request behind the same logical case, and the guard can refuse that
 * one after the first already dispatched and got billed. `ExtractorOutcome.failure` only speaks
 * to the request that threw, so this file is what checks, per case, whether an earlier request
 * already bought a response before folding a late refusal into "never asked". A case like that is
 * recorded as `interrupted`, not `refused`.
 */

export type ExtractionExtractor = 'entities' | 'cognitive';

/** Both calls the experiment makes per fixture, in the order it makes them. */
export const EXTRACTION_EXTRACTORS: readonly ExtractionExtractor[] = ['entities', 'cognitive'];

/** What a case is, which is also what an unrun list is made of. */
export type ExtractionCaseId = {
  readonly condition: CampaignCondition;
  readonly fixtureId: string;
  readonly extractor: ExtractionExtractor;
};

/**
 * The input, by reference and by digest. The fixture id resolves to the episode in
 * `fixtures.ts`; the digest pins the exact rendered text that fixture produced at run time, so a
 * later reader can tell a fixture edit from a model difference.
 */
export type ExtractionInputRef = {
  readonly fixtureId: string;
  readonly chars: number;
  readonly sha256: string;
};

/**
 * One extracted value as the model returned it. Entities carry a name and an entity type;
 * cognitive nodes carry their claim text and node label. Both reduce to this pair, and the pair
 * is what grounding is inspected against.
 */
export type ExtractedItem = {
  readonly type: string;
  readonly text: string;
};

/** Who produced the answer: the extractor, the model behind it, and the frame it was sent under. */
export type ExtractorIdentity = {
  readonly extractor: ExtractionExtractor;
  readonly model: string;
  readonly frameOverride: FrameOverride | undefined;
};

/**
 * One case's outcome. The union is the separation: an unrun case carries no validity to read,
 * and a refusal carries no extracted values to mistake for an empty answer.
 *
 * `interrupted` is the fourth status the union needs: an earlier request in this case already
 * dispatched and bought a response, but a later request (the constrained JSON retry) was refused
 * before the case produced anything a caller could read as valid or invalid. It carries no
 * `valid` either, for the same reason a refusal does not: nobody ever saw a final answer to
 * judge. What it is not is `refused` — a refused case's whole point is that nothing was ever
 * dispatched, and this one dispatched at least once.
 */
export type ExtractionCaseOutcome =
  | {
      readonly execution: 'dispatched';
      readonly valid: true;
      readonly extracted: readonly ExtractedItem[];
      readonly latencyMs: number;
    }
  | {
      readonly execution: 'dispatched';
      readonly valid: false;
      readonly failure: ExtractionFailure;
      readonly error: string;
      readonly latencyMs: number;
    }
  | {
      readonly execution: 'interrupted';
      readonly error: string;
      readonly latencyMs: number;
    }
  | {
      readonly execution: 'refused';
      readonly error: string;
      readonly latencyMs: number;
    }
  | {
      readonly execution: 'unrun';
      readonly reason: string;
    };

export type ExtractionCaseRecord = ExtractionCaseId & {
  readonly identity: ExtractorIdentity;
  readonly input: ExtractionInputRef;
  readonly outcome: ExtractionCaseOutcome;
};

/**
 * How one condition's client is built. The frame comes from the campaign context that also owns
 * the recording identity, so the arm a request is sent under and the arm its usage row names are
 * the same field rather than two readings that can drift.
 */
export type ExtractionClientContext = {
  readonly condition: CampaignCondition;
  readonly frameOverride: FrameOverride | undefined;
  readonly recordApiCall: (call: ApiCall) => void;
};

export type ExtractionClientFactory = (context: ExtractionClientContext) => ProviderGenerateDeps;

export type ExtractionExperimentOptions = {
  readonly producer: CampaignProducerHandle;
  readonly clientFor: ExtractionClientFactory;
  readonly fixtures?: readonly QualityFixture[];
  readonly conditions?: readonly CampaignCondition[];
};

export type ExtractionExperimentResult = {
  readonly records: readonly ExtractionCaseRecord[];
  /** Every case the plan named, whether or not it ran. */
  readonly planned: number;
  /** Cases that sent at least one request, `interrupted` outcomes included. */
  readonly dispatched: number;
  /** Cases refused before their first request, `interrupted` outcomes excluded. */
  readonly refused: number;
  /** The cases after the stop, by identity, so a stopped run says what it never asked. */
  readonly unrun: readonly ExtractionCaseId[];
  /** The case whose refusal or interruption stopped the run. Absent on a run that finished its plan. */
  readonly stoppedAt?: ExtractionCaseId;
};

const STOPPED_ON_CAP = 'the campaign cap refused an earlier case; this one was never dispatched';

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function inputRefOf(fixture: QualityFixture, text: string): ExtractionInputRef {
  return { fixtureId: fixture.id, chars: text.length, sha256: digestOf(text) };
}

/** The case label the ledger row carries. The condition is on the row already, from the context. */
export function extractionCaseKey(fixtureId: string, extractor: ExtractionExtractor): string {
  return `${fixtureId}/${extractor}`;
}

/**
 * One call, retained before anything summarizes it. The entity and cognitive routes return
 * different shapes and the same question is asked of both, so both are flattened to the
 * `{type, text}` pair the record holds.
 */
async function runCase(
  deps: ProviderGenerateDeps,
  extractor: ExtractionExtractor,
  text: string,
): Promise<ExtractionCaseOutcome> {
  if (extractor === 'entities') {
    const outcome = await extractEntitiesViaProvider(deps, text);
    if (outcome.ok) {
      return {
        execution: 'dispatched',
        valid: true,
        extracted: outcome.value.entities.map((entity) => ({
          type: entity.type,
          text: entity.name,
        })),
        latencyMs: outcome.latencyMs,
      };
    }
    return failureOutcome(outcome.failure, outcome.error, outcome.latencyMs);
  }
  const outcome = await extractCognitiveViaProvider(deps, text);
  if (outcome.ok) {
    return {
      execution: 'dispatched',
      valid: true,
      extracted: outcome.value.nodes.map((node) => ({ type: node.type, text: node.text })),
      latencyMs: outcome.latencyMs,
    };
  }
  return failureOutcome(outcome.failure, outcome.error, outcome.latencyMs);
}

/**
 * `failure` is read off the request that actually threw, which for a case whose structured call
 * made a constrained retry is the SECOND physical request, not the case as a whole. A `refused`
 * verdict here means that request never left; whether an earlier request in the same case already
 * left and got billed is not something this function can see, so the caller reconciles that
 * against what it observed was actually recorded before deciding whether the case stays `refused`
 * or becomes `interrupted`.
 */
function failureOutcome(
  failure: ExtractionFailure,
  error: string,
  latencyMs: number,
): ExtractionCaseOutcome {
  if (failure === 'refused') {
    return { execution: 'refused', error, latencyMs };
  }
  return { execution: 'dispatched', valid: false, failure, error, latencyMs };
}

/**
 * The plan, run in order, stopping on the first case that never produced a usable answer:
 * a refusal before its first request, or an interruption after its last one.
 *
 * Stopping is what the campaign cap means: past it nothing can dispatch, so continuing would
 * write a run of refusals and then assert paid rows for them. The remaining case identities are
 * preserved instead, which is what makes a stopped measurement legible as incomplete rather than
 * as a model that answered badly 18 times.
 */
export async function runExtractionExperiment(
  options: ExtractionExperimentOptions,
): Promise<ExtractionExperimentResult> {
  const fixtures = options.fixtures ?? QUALITY_FIXTURES;
  const conditions = options.conditions ?? CAMPAIGN_CONDITIONS;

  const records: ExtractionCaseRecord[] = [];
  const unrun: ExtractionCaseId[] = [];
  let stoppedAt: ExtractionCaseId | undefined;
  let planned = 0;
  let dispatched = 0;
  let refused = 0;

  for (const condition of conditions) {
    // One context per arm: the frame the client sends and the condition the usage row names are
    // read off it, so a no-frame request cannot record as shipped-frame.
    const arm = options.producer.openCondition(condition);
    // Counts billed responses recorded while the case in progress runs, reset per case below.
    // This is the observed evidence a `refused` verdict alone cannot carry: `deps.generate` can
    // dispatch and get billed on its first request, then throw a refusal from its constrained
    // retry, and the thrown error says nothing about the request that came before it.
    let billedInCase = 0;
    const deps = options.clientFor({
      condition: arm.condition,
      frameOverride: arm.frameOverride,
      recordApiCall: (call) => {
        billedInCase += 1;
        arm.recordApiCall(call);
      },
    });
    const identityOf = (extractor: ExtractionExtractor): ExtractorIdentity => ({
      extractor,
      model: deps.model,
      frameOverride: arm.frameOverride,
    });

    for (const fixture of fixtures) {
      const text = renderEpisodeText(fixture.content);
      const input = inputRefOf(fixture, text);
      for (const extractor of EXTRACTION_EXTRACTORS) {
        planned += 1;
        const id: ExtractionCaseId = { condition, fixtureId: fixture.id, extractor };
        if (stoppedAt !== undefined) {
          unrun.push(id);
          records.push({
            ...id,
            identity: identityOf(extractor),
            input,
            outcome: { execution: 'unrun', reason: STOPPED_ON_CAP },
          });
          continue;
        }

        arm.beginCase(extractionCaseKey(fixture.id, extractor));
        billedInCase = 0;
        const outcome = await runCase(deps, extractor, text);
        // A refusal this case's own earlier request already bought a response ahead of is not a
        // case that was never asked; it dispatched once and then could not finish. Reclassifying
        // it here, against what was actually recorded, is what corrects the false zero-dispatch
        // reading without touching `failureOutcome`'s per-request classification above.
        const settled: ExtractionCaseOutcome =
          outcome.execution === 'refused' && billedInCase > 0
            ? { execution: 'interrupted', error: outcome.error, latencyMs: outcome.latencyMs }
            : outcome;
        records.push({ ...id, identity: identityOf(extractor), input, outcome: settled });
        if (settled.execution === 'refused') {
          refused += 1;
          stoppedAt = id;
          continue;
        }
        dispatched += 1;
        if (settled.execution === 'interrupted') {
          // The plan still stops here: what follows the interruption was never asked, exactly as
          // it would not be after a clean refusal.
          stoppedAt = id;
        }
      }
    }
  }

  return {
    records,
    planned,
    dispatched,
    refused,
    unrun,
    ...(stoppedAt === undefined ? {} : { stoppedAt }),
  };
}

/**
 * How many of these cases are known, from their own outcome, to have bought at least one billed
 * response: a valid answer, a schema-invalid one (the JSON still arrived and still cost money),
 * or an interrupted case (its earlier request already got one before the later one was refused).
 * A transport rejection and a timeout buy nothing reliably, and neither does a clean refusal, so
 * none of those three count. This is the bound a usage-row count should be checked against,
 * never the raw dispatched count: a dispatched case that failed transport-side is real and still
 * owes the ledger nothing.
 */
export function billedCaseCount(records: readonly ExtractionCaseRecord[]): number {
  return records.filter((record) => {
    const { outcome } = record;
    if (outcome.execution === 'interrupted') {
      return true;
    }
    return (
      outcome.execution === 'dispatched' && (outcome.valid || outcome.failure === 'invalid_output')
    );
  }).length;
}

/** One line per case, for the run log the campaign keeps. Retained values included. */
export function describeExtractionRecord(record: ExtractionCaseRecord): string {
  return JSON.stringify({
    condition: record.condition,
    fixture: record.fixtureId,
    extractor: record.extractor,
    model: record.identity.model,
    frameOverride: record.identity.frameOverride ?? null,
    input: record.input,
    outcome: record.outcome,
  });
}
