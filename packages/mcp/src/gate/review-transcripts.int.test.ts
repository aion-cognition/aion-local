import {
  DEFAULTS,
  EntityDedupStage,
  judgeContradiction,
  PIPELINE_VERSION,
  ProviderRouter,
  reviewContradiction,
  writeStampedNode,
  type Config,
  type Provider,
} from '@aion/core';
import { errorMessage } from '@aion/core/infrastructure/errors.js';
import { linkEntityMentions } from '@aion/core/infrastructure/graph/entity-mention-queries.js';
import {
  mergeEntities,
  writeEntityVectors,
} from '@aion/core/infrastructure/graph/entity-queries.js';
import { splitSystem } from '@aion/core/infrastructure/providers/anthropic-provider.js';
import { composeSystemBlocks } from '@aion/core/infrastructure/providers/request-blocks.js';
import {
  openCampaignProducer,
  type CampaignProducerHandle,
} from '@aion/core/infrastructure/providers/test-support/campaign-guard.js';
import { testGenerationConfig } from '@aion/core/infrastructure/providers/test-support/generation-provider.js';
import type { StructuredRequest, Vector } from '@aion/core/infrastructure/providers/types.js';
import { normalizeEntityName } from '@aion/core/reflection/domain/entity-extraction.js';
import {
  entityNameVectorText,
  vectorInputHash,
} from '@aion/core/reflection/domain/vector-input.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REVIEW_PROMPT as ENTITY_REVIEW_PROMPT } from '@aion/core/prompts/entity-merge-judge.js';

import { CASCADE_BATTERY, type CascadeCase } from './entity-cascade-precision.fixture.js';
import { GateSubstrate, REMOTE_JUDGE_ABSENT } from './gate-substrate.fixture.js';
import { PRECISION_BATTERY } from './supersession-precision.fixture.js';

/**
 * The exact exchanges behind a handful of second-pass outcomes, printed rather than scored.
 *
 * The precision batteries report how often the review pass agrees with the committed truth, and
 * that number cannot say why a veto happened: whether the reviewer found a real gap in the
 * evidence, read an unstated detail as contrary evidence, or argued against a sound judgment. The
 * only way to tell is to read what each pass was sent and what it answered. This file sends the
 * same calls the shipped stages send, through the same functions, and prints both sides of each.
 *
 * It never runs by default. It spends money, it decides nothing, and nothing in the product reads
 * it: `AION_REVIEW_TRANSCRIPTS=1` opts in, and the selected route's key has to be exported too.
 * `AION_REVIEW_TRANSCRIPT_REPEATS` asks each review again on the same request, because a single
 * answer at temperature zero can still move between calls and a veto seen once is not a pattern.
 *
 * The supersession half sweeps the first pass over one true replacement stated as an event and every
 * case whose truth is no contradiction, since a false positive is only known by asking. The entity
 * half builds each pair into a real graph and runs the shipped cascade stage, so the facts the
 * judge reads are the ones the stage measures rather than ones written here.
 */

const ENABLED = process.env.AION_REVIEW_TRANSCRIPTS === '1';

const REPEATS = Math.min(5, Math.max(1, Number(process.env.AION_REVIEW_TRANSCRIPT_REPEATS ?? 1)));

const TIMEOUT_MS = 120_000;

const DEADLINE_MS = 900_000;

/**
 * A true replacement stated as an event, which a reviewer can mistake for a record of one occasion
 * that leaves the standing value in place.
 */
const EVENT_REPLACEMENT_CASE = 'halyard-primary';

/**
 * Two duplicates that differ by a legal suffix and by an initialism, where a reviewer can argue a
 * separation the records never state, and a company beside the product named after it.
 */
const ENTITY_KEYS = ['anthropic', 'gds', 'retell'];

const NOW = new Date('2026-09-01T00:00:00.000Z');

const SESSION_ID = 'review-transcripts';

type Exchange = {
  readonly caseKey: string;
  readonly pass: string;
  readonly instructions: string;
  readonly input: string;
  readonly answer: string;
};

/** Which pass a request is, read off the schema it asks the model to satisfy. */
function passOf(request: StructuredRequest): string {
  const properties = Object.keys(
    (request.schema.properties as Record<string, unknown> | undefined) ?? {},
  );
  if (properties.includes('earlier_survives')) {
    return 'supersession review';
  }
  if (properties.includes('contradicts')) {
    return 'supersession judge';
  }
  if (properties.includes('different_referent')) {
    return 'entity review';
  }
  return 'entity detect';
}

/**
 * Passes every call through untouched and keeps what was sent and what came back. The
 * instructions are composed the way both backends compose them, so the printed text is the text
 * the model read, frame included.
 */
class RecordingProvider implements Provider {
  readonly route: NonNullable<Provider['route']>;
  readonly exchanges: Exchange[] = [];
  readonly requests: { readonly caseKey: string; readonly request: StructuredRequest }[] = [];
  caseKey = 'unnamed';
  readonly #inner: Provider;

  constructor(inner: Provider) {
    if (inner.route === undefined) {
      throw new Error('the transcript harness needs a routed provider');
    }
    this.#inner = inner;
    this.route = inner.route;
  }

  embed(texts: readonly string[]): Promise<Vector[]> {
    return this.#inner.embed(texts);
  }

  async generate(request: StructuredRequest): Promise<unknown> {
    const { system, rest } = splitSystem(request.messages);
    const sent = {
      caseKey: this.caseKey,
      pass: passOf(request),
      instructions: composeSystemBlocks({
        surface: request.surface,
        instructions: system,
        schema: request.schema,
        promptCache: false,
      })
        .map((block) => block.text)
        .join('\n\n'),
      input: rest.map((message) => message.content).join('\n\n'),
    };
    this.requests.push({ caseKey: this.caseKey, request });
    try {
      const raw = await this.#inner.generate(request);
      this.exchanges.push({ ...sent, answer: JSON.stringify(raw) });
      return raw;
    } catch (error) {
      this.exchanges.push({ ...sent, answer: `error: ${errorMessage(error)}` });
      throw error;
    }
  }
}

/** Instructions are printed once per pass kind: they do not vary with the case. */
function printExchanges(title: string, exchanges: readonly Exchange[]): void {
  const shown = new Set<string>();
  const lines = [`===== ${title}`];
  for (const exchange of exchanges) {
    lines.push(`--- ${exchange.caseKey} / ${exchange.pass}`);
    if (!shown.has(exchange.pass)) {
      shown.add(exchange.pass);
      lines.push('[instructions]', exchange.instructions);
    }
    lines.push('[input]', exchange.input, '[answer]', exchange.answer);
  }
  console.log(lines.join('\n'));
}

function transcriptConfig(): Config {
  return {
    ...DEFAULTS,
    ollama: { ...DEFAULTS.ollama, url: process.env.AION_OLLAMA_URL ?? 'http://127.0.0.1:11434' },
    ...testGenerationConfig(DEFAULTS),
  };
}

/**
 * The supersession stage's two calls in its own order, with the review asked `REPEATS` times on
 * an affirmative. A negative first pass gets no review, as in the stage.
 */
async function supersessionTranscripts(): Promise<{
  readonly route: string;
  readonly exchanges: readonly Exchange[];
  readonly affirmedFalse: readonly string[];
}> {
  const config = transcriptConfig();
  const producer: CampaignProducerHandle = openCampaignProducer({
    experiment: 'review-transcripts',
    ceilingUsd: config.anthropic.dailyCeilingUsd,
  });
  try {
    const router = new ProviderRouter({
      config,
      spending: producer.guard,
      recordApiCall: producer.recordApiCall,
    });
    const recorder = new RecordingProvider(router.forRole('reflect'));
    const { model } = router.routing.roles.reflect;
    const cases = PRECISION_BATTERY.filter(
      (entry) => entry.key === EVENT_REPLACEMENT_CASE || !entry.contradicts,
    );
    const affirmedFalse: string[] = [];
    for (const entry of cases) {
      recorder.caseKey = entry.key;
      producer.beginCase(entry.key);
      const pair = {
        priorLabel: entry.priorLabel,
        currentLabel: entry.currentLabel,
        prior: entry.prior,
        current: entry.current,
        sharedSubject: entry.subject,
      };
      const first = await judgeContradiction(recorder, pair, { model, timeoutMs: TIMEOUT_MS });
      if (first.status !== 'judged' || !first.judgment.contradicts) {
        continue;
      }
      if (!entry.contradicts) {
        affirmedFalse.push(entry.key);
      }
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        await reviewContradiction(recorder, pair, { model, timeoutMs: TIMEOUT_MS });
      }
    }
    return {
      route: `${recorder.route.provider}/${model}`,
      exchanges: recorder.exchanges,
      affirmedFalse,
    };
  } finally {
    producer.close();
  }
}

async function seedSide(
  substrate: GateSubstrate,
  side: CascadeCase['left'],
  episodeId: string,
): Promise<string> {
  const [merged] = await mergeEntities(
    substrate.driver,
    [
      {
        name: side.name,
        nameNorm: normalizeEntityName(side.name),
        type: side.type,
        text: side.description,
        sourceEpisodeId: episodeId,
        extractionMethod: 'cascade_battery',
        confidence: 1,
        occurredAt: NOW,
      },
    ],
    NOW,
  );
  if (merged === undefined) {
    throw new Error(`the harness failed to seed ${side.name}`);
  }
  return merged.id;
}

/** The cascade battery's own seeding: a private episode per side plus the shared ones. */
async function seedCase(substrate: GateSubstrate, entry: CascadeCase): Promise<string> {
  const left = `${entry.key}-left`;
  const right = `${entry.key}-right`;
  const shared = Array.from(
    { length: entry.coMentions },
    (_, index) => `${entry.key}-shared-${String(index)}`,
  );
  for (const id of [left, right, ...shared]) {
    await writeStampedNode(substrate.driver, {
      label: 'Episode',
      id,
      now: NOW,
      occurredAt: NOW,
      properties: { text: id, session_id: SESSION_ID },
    });
  }
  const leftId = await seedSide(substrate, entry.left, left);
  const rightId = await seedSide(substrate, entry.right, right);
  const mentions: readonly (readonly [string, readonly string[]])[] = [
    [left, [leftId]],
    [right, [rightId]],
    ...shared.map((id) => [id, [leftId, rightId]] as const),
  ];
  for (const [episodeId, entityIds] of mentions) {
    await linkEntityMentions(substrate.driver, {
      episodeId,
      entityIds,
      now: NOW,
      confidence: 1,
      provenance: ['cascade_battery'],
    });
  }
  const texts = [entry.left.name, entry.right.name].map((name) =>
    entityNameVectorText(normalizeEntityName(name), []),
  );
  const vectors = await substrate.provider.embed(texts);
  await writeEntityVectors(
    substrate.driver,
    [leftId, rightId].map((id, index) => ({
      id,
      nameVector: vectors[index] ?? [],
      nameVectorHash: vectorInputHash(texts[index] ?? ''),
    })),
  );
  return shared[0] ?? left;
}

/**
 * The shipped cascade stage on each pair, pinned to `unanimous` as the battery pins it, then
 * every review request it sent asked again `REPEATS - 1` times, unchanged.
 */
async function entityTranscripts(substrate: GateSubstrate): Promise<readonly Exchange[]> {
  const recorder = new RecordingProvider(substrate.provider);
  for (const entry of CASCADE_BATTERY.filter((row) => ENTITY_KEYS.includes(row.key))) {
    const episodeId = await seedCase(substrate, entry);
    recorder.caseKey = entry.key;
    substrate.beginCase(entry.key);
    const stage = new EntityDedupStage({
      model: DEFAULTS.anthropic.model,
      timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
      similarityThreshold: DEFAULTS.reflection.entityDedupThreshold,
      sharedEpisodeJaccardFloor: DEFAULTS.reflection.entityNominationJaccardFloor,
      mode: 'unanimous',
    });
    await stage.run({
      driver: substrate.driver,
      db: substrate.db,
      provider: recorder,
      episodeId,
      episode: { id: episodeId, sessionId: SESSION_ID, text: '', turns: [] },
      logger: substrate.logger,
      now: NOW,
      occurredAt: NOW,
      pipelineVersion: PIPELINE_VERSION,
    });
  }
  const reviews = recorder.requests.filter(({ request }) => passOf(request) === 'entity review');
  for (const { caseKey, request } of reviews) {
    recorder.caseKey = caseKey;
    for (let attempt = 1; attempt < REPEATS; attempt += 1) {
      await recorder.generate(request);
    }
  }
  return [...recorder.exchanges].sort((left, right) => left.caseKey.localeCompare(right.caseKey));
}

describe.skipIf(!ENABLED || REMOTE_JUDGE_ABSENT)('second-pass review transcripts', () => {
  let supersession: Awaited<ReturnType<typeof supersessionTranscripts>>;
  let entity: readonly Exchange[] = [];
  let substrate: GateSubstrate | undefined;

  beforeAll(async () => {
    supersession = await supersessionTranscripts();
    substrate = new GateSubstrate('review-transcripts');
    await substrate.open();
    entity = await entityTranscripts(substrate);
  }, DEADLINE_MS);

  afterAll(async () => {
    await substrate?.close();
  });

  it('prints the supersession exchanges for the event replacement and every false positive', () => {
    const shown = new Set([EVENT_REPLACEMENT_CASE, ...supersession.affirmedFalse]);
    const negatives = supersession.exchanges
      .filter((exchange) => !shown.has(exchange.caseKey))
      .map((exchange) => exchange.caseKey);
    console.log(
      `supersession route ${supersession.route}; review repeats ${String(REPEATS)}; ` +
        `first-pass false positives: [${supersession.affirmedFalse.join(', ')}]; ` +
        `answered no with no review: [${negatives.join(', ')}]`,
    );
    printExchanges(
      'supersession',
      supersession.exchanges.filter((exchange) => shown.has(exchange.caseKey)),
    );

    expect(supersession.exchanges.every((row) => !row.answer.startsWith('error'))).toBe(true);
  });

  it('prints the entity cascade exchanges for the split pairs and the contrast pair', () => {
    printExchanges('entity cascade', entity);

    expect(entity.length).toBeGreaterThan(0);
  });
});

/**
 * The entity reviewer on every battery pair, true separations included, under each candidate
 * wording of its prompt.
 *
 * In the stage the reviewer sees only pairs the first pass called one referent, and the first
 * pass declines every non-duplicate in the battery, so the battery cannot say whether the review
 * would still catch a first-pass mistake after its prompt changes. Here each pair's first-pass
 * request is resent as a review under each wording, which is exactly the request
 * `reviewEntityMerge` sends: same surface, same pair text, the review schema. A veto on a
 * duplicate is an error the review adds; a veto on a non-duplicate is the catch it exists for.
 *
 * `AION_REVIEW_SWEEP=1` opts in, separately from the transcripts above.
 */
const SWEEP_ENABLED = process.env.AION_REVIEW_SWEEP === '1';

const REVIEW_SCHEMA: StructuredRequest['schema'] = {
  type: 'object',
  properties: { reason: { type: 'string' }, different_referent: { type: 'boolean' } },
  required: ['reason', 'different_referent'],
};

const ROLE = 'argue the other side.';

/** The first pass's own definition of one referent, stated as the review's standard too. */
const SAME_DEFINITION =
  ' Use the definition of one referent the claim was made under: a nickname, an abbreviation, a ' +
  'fuller form of the same name, and a product named after the company that makes it are one ' +
  'referent, so none of those is a separation.';

const STATED_SEPARATION =
  ' A separation is something the records state or show; that they never say the two are one ' +
  'is not a separation.';

function reviewVariants(): readonly { readonly name: string; readonly prompt: string }[] {
  if (!ENTITY_REVIEW_PROMPT.includes(ROLE)) {
    throw new Error('the review prompt no longer states its role the way the sweep edits it');
  }
  const defined = ENTITY_REVIEW_PROMPT.replace(ROLE, `${ROLE}${SAME_DEFINITION}`);
  return [
    { name: 'shipped', prompt: ENTITY_REVIEW_PROMPT },
    { name: 'same-definition', prompt: defined },
    { name: 'same-definition+stated', prompt: `${defined}${STATED_SEPARATION}` },
  ];
}

function asReview(request: StructuredRequest, prompt: string): StructuredRequest {
  const { signal: _signal, ...rest } = request;
  return {
    ...rest,
    messages: request.messages.map((message) =>
      message.role === 'system' ? { ...message, content: prompt } : message,
    ),
    schema: REVIEW_SCHEMA,
  };
}

describe.skipIf(!SWEEP_ENABLED || REMOTE_JUDGE_ABSENT)('entity review sweep', () => {
  let substrate: GateSubstrate | undefined;

  beforeAll(async () => {
    substrate = new GateSubstrate('review-sweep');
    await substrate.open();
  }, DEADLINE_MS);

  afterAll(async () => {
    await substrate?.close();
  });

  it(
    'prints each wording against every pair the first pass saw',
    async () => {
      const open = substrate!;
      const recorder = new RecordingProvider(open.provider);
      const cases = CASCADE_BATTERY.filter((row) => row.caseClass !== 'separator');
      for (const entry of cases) {
        const episodeId = await seedCase(open, entry);
        recorder.caseKey = entry.key;
        open.beginCase(entry.key);
        const stage = new EntityDedupStage({
          model: DEFAULTS.anthropic.model,
          timeoutMs: DEFAULTS.reflection.stageTimeoutMs,
          similarityThreshold: DEFAULTS.reflection.entityDedupThreshold,
          sharedEpisodeJaccardFloor: DEFAULTS.reflection.entityNominationJaccardFloor,
          mode: 'propose',
        });
        await stage.run({
          driver: open.driver,
          db: open.db,
          provider: recorder,
          episodeId,
          episode: { id: episodeId, sessionId: SESSION_ID, text: '', turns: [] },
          logger: open.logger,
          now: NOW,
          occurredAt: NOW,
          pipelineVersion: PIPELINE_VERSION,
        });
      }

      const truth = new Map(cases.map((entry) => [entry.key, entry.duplicate]));
      const detects = recorder.requests.filter(
        ({ request }) => passOf(request) === 'entity detect',
      );
      const lines = [`entity review sweep, route ${JSON.stringify(recorder.route)}`];
      for (const variant of reviewVariants()) {
        let dupVetoes = 0;
        let dupAsked = 0;
        let distinctVetoes = 0;
        let distinctAsked = 0;
        for (const { caseKey, request } of detects) {
          const duplicate = truth.get(caseKey) === true;
          const verdicts: string[] = [];
          for (let attempt = 0; attempt < REPEATS; attempt += 1) {
            recorder.caseKey = `${caseKey}/${variant.name}`;
            let answer: { different_referent?: unknown; reason?: unknown } = {};
            try {
              answer = (await recorder.generate(
                asReview(request, variant.prompt),
              )) as typeof answer;
            } catch {
              verdicts.push('error');
              continue;
            }
            const veto = answer.different_referent === true;
            verdicts.push(veto ? 'veto' : 'pass');
            if (duplicate) {
              dupAsked += 1;
              dupVetoes += veto ? 1 : 0;
            } else {
              distinctAsked += 1;
              distinctVetoes += veto ? 1 : 0;
            }
            if (veto === duplicate) {
              lines.push(
                `  ${variant.name} ${caseKey} (${duplicate ? 'duplicate' : 'distinct'}) ` +
                  `${veto ? 'VETO' : 'PASS'}: ${String(answer.reason)}`,
              );
            }
          }
          lines.push(
            `${variant.name} ${caseKey} duplicate=${String(duplicate)} ${verdicts.join(',')}`,
          );
        }
        lines.push(
          `SUMMARY ${variant.name}: vetoed ${String(dupVetoes)}/${String(dupAsked)} duplicates ` +
            `(errors added), ${String(distinctVetoes)}/${String(distinctAsked)} distinct pairs ` +
            '(catches)',
        );
      }
      console.log(lines.join('\n'));
      expect(detects.length).toBeGreaterThan(0);
    },
    DEADLINE_MS,
  );
});
