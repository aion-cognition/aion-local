import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  billedCaseCount,
  describeExtractionRecord,
  runExtractionExperiment,
  type ExtractionCaseRecord,
  type ExtractionExperimentResult,
} from './extraction-experiment.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { AnthropicHaikuClient } from '../../../infrastructure/providers/test-support/anthropic-client.js';
import {
  CAMPAIGN_CONDITIONS,
  openCampaignProducer,
  type CampaignProducerHandle,
} from '../../../infrastructure/providers/test-support/campaign-guard.js';

/**
 * The extraction-faithfulness experiment's live execution entry point.
 *
 * The run itself is `extraction-experiment.ts`, which `extraction-faithfulness-rehearsal.test.ts`
 * exercises with injected responses over the same code. What is here is the live wiring: the key
 * gate, the guarded client, and the observations the packet reads. The two files exist apart
 * because a rehearsal with a stubbed `fetchImpl` is a proof of the path and never a measurement:
 * no rehearsal can answer what the extractors do with a real answer.
 *
 * This file runs BOTH frame conditions in ONE invocation. Each arm opens its own campaign
 * condition context, so the frame a request carries and the condition its usage row names come
 * off the same field. The runner invokes it once; it does not read `TEST_AION_FRAME_OVERRIDE`.
 *
 * `quality-harness/run.ts`'s standalone `npm run quality:extraction` CLI constructs its own
 * unguarded client and is not an entry point this campaign invokes. Everything here holds against
 * the shared campaign ledger's guard and records each billed response on that same file.
 *
 * With no key in the environment the whole file skips, the same way every other live battery in
 * this workspace does: a run with nowhere to dispatch measures nothing.
 */

const API_KEY = (process.env.AION_ANTHROPIC_API_KEY ?? '').trim();
const MODEL = process.env.AION_ANTHROPIC_MODEL ?? DEFAULTS.anthropic.model;

/** Nine fixtures, two calls each, under two conditions, at a second or two a call. */
const EXPERIMENT_DEADLINE_MS = 900_000;

let producer: CampaignProducerHandle | undefined;
let result: ExtractionExperimentResult | undefined;

beforeAll(async () => {
  if (API_KEY === '') {
    return;
  }
  const opened = openCampaignProducer({
    experiment: 'extraction-faithfulness',
    ceilingUsd: DEFAULTS.anthropic.dailyCeilingUsd,
  });
  producer = opened;

  result = await runExtractionExperiment({
    producer: opened,
    clientFor: (context) => {
      const client = new AnthropicHaikuClient({
        apiKey: API_KEY,
        spending: opened.guard,
        recordApiCall: context.recordApiCall,
        ...(context.frameOverride === undefined ? {} : { frameOverride: context.frameOverride }),
      });
      return {
        generate: (req: Parameters<AnthropicHaikuClient['generate']>[0]) => client.generate(req),
        model: MODEL,
      };
    },
  });
}, EXPERIMENT_DEADLINE_MS);

afterAll(() => {
  producer?.close();
});

function readResult(): ExtractionExperimentResult {
  if (result === undefined) {
    throw new Error('the experiment did not run');
  }
  return result;
}

function answeredIn(
  records: readonly ExtractionCaseRecord[],
): readonly (ExtractionCaseRecord & { outcome: { execution: 'dispatched'; valid: true } })[] {
  return records.filter(
    (
      record,
    ): record is ExtractionCaseRecord & { outcome: { execution: 'dispatched'; valid: true } } =>
      record.outcome.execution === 'dispatched' && record.outcome.valid,
  );
}

describe.skipIf(API_KEY === '')('the extraction-faithfulness sample', () => {
  it('names the route it measured, so the numbers belong to a model', () => {
    const run = readResult();
    console.log(
      `extraction-faithfulness route: model ${MODEL}, condition pair ` +
        `${CAMPAIGN_CONDITIONS.join('/')}, ${String(run.planned)} case(s) planned`,
    );
    expect(run.records).toHaveLength(run.planned);
  });

  /**
   * The material the faithfulness question is answered from, printed before anything reduces it.
   * A count and a schema verdict cannot separate a grounded answer from an invented one, so the
   * values themselves go on the record, beside the fixture and the arm that produced them.
   */
  it('retains what each extractor actually returned, with its fixture and condition', () => {
    const run = readResult();
    for (const record of run.records) {
      console.log(`extraction-record ${describeExtractionRecord(record)}`);
    }
    for (const record of answeredIn(run.records)) {
      expect(record.input.sha256).toHaveLength(64);
      expect(record.identity.model).toBe(MODEL);
    }
  });

  /**
   * The observation the packet reads. Schema validity is a property of the answer this run got;
   * it is printed per condition rather than asserted against a bar, because what the experiment
   * asks is whether the frame changes what the extractors return, not whether either condition
   * clears a threshold this campaign would then be free to act on.
   */
  it('reports execution and validity per condition, as two separate counts', () => {
    const run = readResult();
    for (const condition of CAMPAIGN_CONDITIONS) {
      const rows = run.records.filter((record) => record.condition === condition);
      const dispatched = rows.filter(
        (row) => row.outcome.execution === 'dispatched' || row.outcome.execution === 'interrupted',
      );
      const interrupted = rows.filter((row) => row.outcome.execution === 'interrupted');
      const valid = answeredIn(rows);
      const extracted = valid.reduce((sum, row) => sum + row.outcome.extracted.length, 0);
      console.log(
        `${condition}: ${String(dispatched.length)}/${String(rows.length)} case(s) dispatched ` +
          `(${String(interrupted.length)} interrupted), ${String(valid.length)} valid answer(s), ` +
          `${String(extracted)} extracted value(s), ` +
          `${String(rows.filter((row) => row.outcome.execution === 'refused').length)} refused, ` +
          `${String(rows.filter((row) => row.outcome.execution === 'unrun').length)} unrun`,
      );
      for (const row of rows) {
        if (row.outcome.execution === 'dispatched' && !row.outcome.valid) {
          console.log(`  ${row.fixtureId}/${row.extractor}: ${row.outcome.error}`);
        }
      }
    }
    // An interrupted run is reported, not asserted away: what it owes is the list of cases it
    // never asked, and that list is exact.
    expect(run.unrun).toHaveLength(run.planned - run.dispatched - run.refused);
  });

  /**
   * The spend record this experiment owes the campaign: one durable row per billed response,
   * under the case that bought it. Bounded by `billedCaseCount`, not by the raw dispatched count:
   * a transport rejection dispatches and owes the ledger nothing, so it must not lower-bound the
   * row count the way a valid or schema-invalid answer does. An interrupted case is bounded the
   * same as a valid one, since its earlier request already got a response before its later one
   * was refused.
   */
  it('leaves one durable usage row per billed response on the campaign ledger', () => {
    const run = readResult();
    const handle = producer;
    expect(handle).toBeDefined();
    if (handle === undefined) {
      return;
    }
    const rows = handle.db
      .prepare(
        `SELECT count(*) AS calls, sum(input_tokens) AS inputTokens
         FROM api_calls WHERE surface LIKE 'f3/extraction-faithfulness/%'`,
      )
      .get() as { calls: number; inputTokens: number | null };
    console.log(
      `extraction-faithfulness recorded ${String(rows.calls)} billed response(s), ` +
        `${String(rows.inputTokens ?? 0)} input token(s), on ${handle.ledgerPath}`,
    );
    // At least one row per case known to have bought a response, plus any write that bought one
    // but failed to land on the ledger: a recording failure still means a response was received.
    expect(rows.calls + handle.recordingFailures()).toBeGreaterThanOrEqual(
      billedCaseCount(run.records),
    );
    expect(handle.recordingFailures()).toBe(0);
  });

  /** The arm a row names is the arm its request carried, which is what the ledger is read on. */
  it('records every row under one of the two named conditions', () => {
    const handle = producer;
    expect(handle).toBeDefined();
    if (handle === undefined) {
      return;
    }
    const rows = handle.db
      .prepare(
        `SELECT surface FROM api_calls WHERE surface LIKE 'f3/extraction-faithfulness/%' ORDER BY id`,
      )
      .all() as { surface: string }[];
    const prefixes = new Set(rows.map((row) => row.surface.split('/').slice(0, 3).join('/')));
    console.log(`extraction-faithfulness condition prefixes: ${[...prefixes].join(', ')}`);
    for (const prefix of prefixes) {
      expect(
        CAMPAIGN_CONDITIONS.map((condition) => `f3/extraction-faithfulness/${condition}`).includes(
          prefix,
        ),
      ).toBe(true);
    }
  });
});
