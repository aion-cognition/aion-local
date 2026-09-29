import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  runExtractionExperiment,
  type ExtractedItem,
  type ExtractionCaseRecord,
} from './extraction-experiment.js';
import { QUALITY_FIXTURES } from './fixtures.js';
import { AnthropicHaikuClient } from '../../../infrastructure/providers/test-support/anthropic-client.js';
import {
  openCampaignProducer,
  type CampaignCondition,
} from '../../../infrastructure/providers/test-support/campaign-guard.js';
import { renderEpisodeText } from '../../domain/content.js';

/**
 * The extraction-faithfulness sample's rehearsal, over the SAME execution and recording path the
 * live root runs (`extraction-experiment.ts`). What the rehearsal can prove is the path: that
 * both arms dispatch under their own frame and record under their own condition, that an actual
 * extracted value survives to the record, and that a refused case is preserved as unrun rather
 * than counted as a bad answer. What it cannot prove is what a real model returns, which is why
 * the live root exists.
 *
 * No live network call is made anywhere in this file; `fetchImpl` is a stub for every request.
 */

function entityResponse(name: string): Response {
  return new Response(
    JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ entities: [{ name, type: 'tool' }] }),
        },
      ],
      usage: { input_tokens: 200, output_tokens: 20 },
    }),
    { status: 200 },
  );
}

function cognitiveResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ nodes: [{ type: 'Insight', text }] }),
        },
      ],
      usage: { input_tokens: 220, output_tokens: 25 },
    }),
    { status: 200 },
  );
}

let dataDir: string | undefined;

afterEach(() => {
  vi.unstubAllEnvs();
  if (dataDir !== undefined) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  }
});

/** A ledger file of this run's own, named the way the campaign runner names the shared one. */
function ledgerFile(): string {
  dataDir = mkdtempSync(join(tmpdir(), 'aion-extraction-faithfulness-'));
  const path = join(dataDir, 'campaign-ledger.sqlite');
  vi.stubEnv('TEST_AION_CAMPAIGN_LEDGER', path);
  return path;
}

type FetchStub = Mock<(...args: Parameters<typeof fetch>) => Promise<Response>>;

/** The stub every arm answers through, keyed on which prompt the request carries. */
function stubbedFetch(entityName: string, claimText: string): FetchStub {
  return vi.fn((..._args: Parameters<typeof fetch>) => {
    const [, init] = _args;
    const body = typeof init?.body === 'string' ? init.body : '';
    return Promise.resolve(
      body.includes('Episode:') ? cognitiveResponse(claimText) : entityResponse(entityName),
    );
  });
}

function extractedIn(records: readonly ExtractionCaseRecord[]): readonly ExtractedItem[] {
  return records.flatMap((record) =>
    record.outcome.execution === 'dispatched' && record.outcome.valid
      ? record.outcome.extracted
      : [],
  );
}

describe('extraction-faithfulness sample rehearsal', () => {
  it('runs all 9 fixtures under both conditions through the guarded client: 36 dispatches, each recorded under its own arm and case', async () => {
    ledgerFile();
    const producer = openCampaignProducer({
      experiment: 'extraction-faithfulness',
      ceilingUsd: 1_000,
    });
    const fetchImpl = stubbedFetch('rehearsal', 'rehearsal insight');
    const armsSeen: { condition: CampaignCondition; framed: boolean }[] = [];
    try {
      const run = await runExtractionExperiment({
        producer,
        clientFor: (context) => {
          armsSeen.push({
            condition: context.condition,
            framed: context.frameOverride !== undefined,
          });
          const client = new AnthropicHaikuClient({
            apiKey: 'sk-ant-test-extraction',
            fetchImpl,
            spending: producer.guard,
            recordApiCall: context.recordApiCall,
            ...(context.frameOverride === undefined
              ? {}
              : { frameOverride: context.frameOverride }),
          });
          return {
            generate: (req: Parameters<AnthropicHaikuClient['generate']>[0]) =>
              client.generate(req),
            model: 'claude-haiku-4-5',
          };
        },
      });

      // 9 fixtures x 2 conditions x 2 calls (entity + cognitive) = 36, matching the campaign
      // matrix's logical-call count for this experiment exactly.
      expect(run.planned).toBe(QUALITY_FIXTURES.length * 2 * 2);
      expect(run.dispatched).toBe(run.planned);
      expect(run.refused).toBe(0);
      expect(run.unrun).toEqual([]);
      expect(fetchImpl).toHaveBeenCalledTimes(run.planned);
      expect(producer.guard.today(new Date()).committedUsd).toBeGreaterThan(0);

      // The no-frame arm is the one that sends a frame override, and it is the arm that opened
      // it. Selection and recording come off one context, which is what the earlier arrangement
      // could not say.
      expect(armsSeen).toEqual([
        { condition: 'no-frame', framed: true },
        { condition: 'shipped-frame', framed: false },
      ]);

      // The half a reservation cannot stand in for: one durable row per billed response, each
      // naming its own condition and case, on the campaign ledger rather than in an array this
      // process throws away.
      const rows = producer.db
        .prepare('SELECT surface, input_tokens AS inputTokens FROM api_calls ORDER BY id')
        .all() as { surface: string; inputTokens: number }[];
      expect(rows).toHaveLength(run.planned);
      // One label per condition-fixture-extractor triple: every measured call is named.
      expect(new Set(rows.map((row) => row.surface)).size).toBe(run.planned);
      expect(rows.every((row) => row.inputTokens > 0)).toBe(true);
      expect(producer.recordingFailures()).toBe(0);

      const [fixture] = QUALITY_FIXTURES;
      expect(fixture).toBeDefined();
      expect(
        rows.filter((row) =>
          row.surface.startsWith(`f3/extraction-faithfulness/no-frame/${fixture!.id}/entities/`),
        ),
      ).toHaveLength(1);
    } finally {
      producer.close();
    }
  });

  /**
   * The acceptance the metrics could not give: a faithful answer and an invented one over the
   * same fixture leave DIFFERENT records, and the invention is visible in them. Schema validity,
   * counts and type histograms are identical across these two runs by construction; what
   * separates them is the retained value against the retained input.
   */
  it('the faithful-versus-invented control: the retained records differ and name the invention', async () => {
    const [fixture] = QUALITY_FIXTURES;
    if (fixture === undefined) {
      throw new Error('QUALITY_FIXTURES must not be empty for this control to mean anything');
    }
    const text = renderEpisodeText(fixture.content);
    const grounded = 'deadlock';
    const invented = 'Zendris Qualifier Bus';
    expect(text.toLowerCase()).toContain(grounded);
    expect(text.toLowerCase()).not.toContain(invented.toLowerCase());

    const runOnce = async (
      entityName: string,
      claimText: string,
    ): Promise<readonly ExtractionCaseRecord[]> => {
      ledgerFile();
      const producer = openCampaignProducer({
        experiment: 'extraction-faithfulness',
        ceilingUsd: 1_000,
      });
      const fetchImpl = stubbedFetch(entityName, claimText);
      try {
        const run = await runExtractionExperiment({
          producer,
          fixtures: [fixture],
          conditions: ['shipped-frame'],
          clientFor: (context) => {
            const client = new AnthropicHaikuClient({
              apiKey: 'sk-ant-test-extraction',
              fetchImpl,
              spending: producer.guard,
              recordApiCall: context.recordApiCall,
            });
            return {
              generate: (req: Parameters<AnthropicHaikuClient['generate']>[0]) =>
                client.generate(req),
              model: 'claude-haiku-4-5',
            };
          },
        });
        expect(run.dispatched).toBe(2);
        return run.records;
      } finally {
        producer.close();
      }
    };

    const faithful = await runOnce(grounded, `the ${grounded} came from cross-table lock ordering`);
    const fabricated = await runOnce(invented, `the ${invented} rewrote the migration plan`);

    const faithfulValues = extractedIn(faithful);
    const fabricatedValues = extractedIn(fabricated);
    console.log(
      JSON.stringify({
        control: 'faithful-versus-invented',
        faithful: faithfulValues,
        fabricated: fabricatedValues,
      }),
    );

    // Same case count, same validity, same type histogram: a counts-and-validity summary cannot
    // tell these two runs apart. The retained values can.
    expect(fabricatedValues).toHaveLength(faithfulValues.length);
    expect(fabricatedValues.map((item) => item.type)).toEqual(
      faithfulValues.map((item) => item.type),
    );
    expect(fabricatedValues).not.toEqual(faithfulValues);

    // And the difference is inspectable against the retained input. Every faithful value names a
    // term the fixture text carries; every fabricated one names a term it does not.
    const source = text.toLowerCase();
    expect(source).toContain(grounded);
    expect(source).not.toContain(invented.toLowerCase());
    expect(faithfulValues.every((item) => item.text.toLowerCase().includes(grounded))).toBe(true);
    expect(
      fabricatedValues.every((item) => item.text.toLowerCase().includes(invented.toLowerCase())),
    ).toBe(true);

    // Both runs retain the same input reference, so the comparison is over one fixture rather
    // than two readings of different text.
    expect(new Set([...faithful, ...fabricated].map((record) => record.input.sha256)).size).toBe(1);
  });

  /**
   * The zero-cap control. A cap already spent refuses before anything is sent, so the run stops
   * and every remaining case is preserved by identity as unrun. None of them is an invalid
   * answer: nobody asked them.
   */
  it('the zero-cap run: nothing dispatches, the refusal stops the run, and the rest stay unrun', async () => {
    ledgerFile();
    const producer = openCampaignProducer({
      experiment: 'extraction-faithfulness',
      ceilingUsd: 0,
    });
    const fetchImpl = stubbedFetch('never-sent', 'never sent');
    try {
      const run = await runExtractionExperiment({
        producer,
        clientFor: (context) => {
          const client = new AnthropicHaikuClient({
            apiKey: 'sk-ant-test-extraction',
            fetchImpl,
            spending: producer.guard,
            recordApiCall: context.recordApiCall,
            ...(context.frameOverride === undefined
              ? {}
              : { frameOverride: context.frameOverride }),
          });
          return {
            generate: (req: Parameters<AnthropicHaikuClient['generate']>[0]) =>
              client.generate(req),
            model: 'claude-haiku-4-5',
          };
        },
      });

      // The proof that nothing escaped the guard: the stubbed fetch never ran at all.
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(run.dispatched).toBe(0);
      expect(run.refused).toBe(1);
      expect(run.stoppedAt).toEqual({
        condition: 'no-frame',
        fixtureId: QUALITY_FIXTURES[0]?.id,
        extractor: 'entities',
      });
      expect(run.unrun).toHaveLength(run.planned - 1);

      // A refusal is an execution fact, not an output verdict. No case in this run is recorded
      // as an invalid answer, because no model was ever asked one.
      expect(
        run.records.filter(
          (record) => record.outcome.execution === 'dispatched' && !record.outcome.valid,
        ),
      ).toEqual([]);
      expect(run.records.filter((record) => record.outcome.execution === 'unrun')).toHaveLength(
        run.planned - 1,
      );
      expect(producer.guard.today(new Date()).committedUsd).toBe(0);

      const rows = producer.db.prepare('SELECT count(*) AS n FROM api_calls').get() as {
        n: number;
      };
      expect(rows.n).toBe(0);
    } finally {
      producer.close();
    }
  });
});
