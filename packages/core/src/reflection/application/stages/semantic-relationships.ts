import { z } from 'zod';

import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import { describeError, formatZodError, isAbortError } from '../../../infrastructure/errors.js';
import {
  findEpisodeEntities,
  type EpisodeEntity,
} from '../../../infrastructure/graph/entity-queries.js';
import {
  findEpisodeCognitiveNodes,
  isSemanticRelationshipType,
  writeSemanticRelationship,
  SEMANTIC_RELATIONSHIP_TYPES,
  type EpisodeCognitiveNode,
  type SemanticRelationshipType,
} from '../../../infrastructure/graph/semantic-relationship-queries.js';
import { deadlineFor } from '../../../infrastructure/providers/deadline-signal.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * One structured-output call per episode proposing typed edges between the entities and
 * cognitive structures the two prior stages already extracted. This stage reads both sets
 * fresh from the graph rather than assuming either stage ran in this pass: an episode
 * enriched before entity or cognitive extraction landed, or one where either stage failed in
 * isolation, simply has fewer candidates to relate.
 */

export const SEMANTIC_RELATIONSHIP_STAGE_NAME = 'semantic-relationships';

export type SemanticRelationshipStageOptions = {
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRelationships?: number;
};

/**
 * The cognitive labels a typed edge may end on. A Goal or Plan is frequently a restatement
 * of the episode's own question or summary (the cognitive stage refuses the worst of these
 * at mint time, but older Goals predate that refusal), and Context, Event, Pattern, and Trend
 * are observations about the episode rather than claims one item can cause, enable, or
 * contradict another with. Entity is separate and always eligible: it is not a cognitive
 * label.
 */
const CLAIM_BEARING_COGNITIVE_LABELS: ReadonlySet<string> = new Set([
  'Decision',
  'Insight',
  'Concept',
]);

/** One entity or cognitive node, keyed for the prompt so the model never has to spell a name back. */
type Candidate = {
  readonly key: string;
  readonly id: string;
  readonly label: string;
};

function buildCandidates(
  entities: readonly EpisodeEntity[],
  cognitive: readonly EpisodeCognitiveNode[],
): Candidate[] {
  const candidates: Candidate[] = [];
  entities.forEach((entity, index) => {
    candidates.push({
      key: `E${index + 1}`,
      id: entity.id,
      label: `${entity.name} (${entity.type})`,
    });
  });
  cognitive
    .filter((node) => CLAIM_BEARING_COGNITIVE_LABELS.has(node.label))
    .forEach((node, index) => {
      candidates.push({ key: `C${index + 1}`, id: node.id, label: `[${node.label}] ${node.text}` });
    });
  return candidates;
}

const SYSTEM_PROMPT = [
  'You infer typed relationships between the entities and cognitive structures already',
  'extracted from one episode. Each item below carries a key; refer to items only by that',
  'key, never by its label, and never relate an item to itself.',
  'Use CAUSES when one item caused another and ENABLES when one item made another possible.',
  'For both, source is the cause and target is the effect. Re-read the quote and identify',
  'which item is the cause before you choose source and target; do not default to the order',
  'the items happen to appear in the episode text, and do not put the effect first because it',
  'was mentioned first. Example: the episode says "the shared transaction caused the',
  'deadlock", the transaction is the cause, so it is source, and the deadlock is the effect,',
  'so it is target, even though "deadlock" appears earlier in that sentence than "the shared',
  'transaction" did.',
  'Use PRECEDES when one item happened before another in a way that matters.',
  'Use CONTRADICTS only when the episode states an explicit contradiction: one item directly',
  "negates, rejects, or reverses the other in the episode's own words. Two items that agree,",
  'restate the same fact in different words, or are simply unrelated do not contradict. A',
  'reason for rejecting or choosing against something is not a contradiction with the thing',
  'itself, or with a restatement of the same reason. That is not a relationship this stage',
  'names at all, so leave it out rather than forcing it into CONTRADICTS. Example: the episode',
  'says "we rejected the queue tool because it is incompatible with our cache", the queue',
  'tool and the cache do not contradict each other, incompatibility between two tools is not',
  "one of this stage's types, so no relationship between them belongs in the answer at all.",
  'When unsure, do not use CONTRADICTS.',
  'Use SIMILAR when two items mean close to the same thing, RELATED_TO when two items are',
  'meaningfully connected but no other type fits, and ANALOGOUS_TO when two items are',
  'similar in kind without one causing, enabling, or preceding the other.',
  'For every relationship, quote the exact words from the episode that justify it: copy the',
  'span verbatim, do not paraphrase or summarize it. A relationship you cannot quote does not',
  'go in the answer.',
  'Give each relationship a confidence between 0 and 1 for how sure the episode makes you.',
  'Propose only relationships the episode actually supports; return an empty list rather than',
  'a weak guess.',
].join(' ');

function buildMessages(text: string, candidates: readonly Candidate[]): ChatMessage[] {
  const items = candidates.map((candidate) => `${candidate.key}: ${candidate.label}`).join('\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Items:\n${items}\n\nEpisode:\n${text}` },
  ];
}

/**
 * The candidate keys and the sanctioned type list both ride the schema, so the model is
 * steered toward a key that exists and a type this stage can write before a single proposal
 * is parsed. Server-side validation still drops anything that gets through anyway.
 */
function buildJsonSchema(candidates: readonly Candidate[]): JsonSchema {
  const keys = candidates.map((candidate) => candidate.key);
  return {
    type: 'object',
    properties: {
      relationships: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: keys },
            target: { type: 'string', enum: keys },
            type: { type: 'string', enum: [...SEMANTIC_RELATIONSHIP_TYPES] },
            confidence: { type: 'number' },
            quote: { type: 'string' },
          },
          required: ['source', 'target', 'type', 'confidence', 'quote'],
        },
      },
    },
    required: ['relationships'],
  };
}

/** Looser than the JSON schema on purpose: a proposal missing an optional field is still usable. */
const ProposalSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.string(),
  confidence: z.number().optional(),
  quote: z.string().optional(),
});

type Proposal = z.infer<typeof ProposalSchema>;

const SemanticRelationshipOutputSchema = z.object({
  relationships: z.array(ProposalSchema),
});

/** Applied only when the model omits the (optional) field; a genuine answer never needs it. */
const DEFAULT_PROPOSAL_CONFIDENCE = 0.5;

/**
 * Named rather than left to the route's default, which the provider no longer sends. The stage
 * proposes edges the graph keeps, so one episode proposes one set of them (mirrors the entity and
 * cognitive stages).
 */
const RELATIONSHIP_TEMPERATURE = 0;

function clampConfidence(value: number | undefined): number {
  const raw = value ?? DEFAULT_PROPOSAL_CONFIDENCE;
  if (!Number.isFinite(raw)) {
    return DEFAULT_PROPOSAL_CONFIDENCE;
  }
  return Math.min(1, Math.max(0, raw));
}

type ResolvedProposal = {
  readonly type: SemanticRelationshipType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly confidence: number;
  /** The verbatim episode span that justifies this edge; never empty once resolved. */
  readonly quote: string;
};

/**
 * Every drop here is a hallucination guard: a key the candidate list never issued, a
 * self-loop, a type outside the sanctioned seven, a pair this same run already proposed, or
 * a quote that is missing or does not appear verbatim in the episode. The last of those is
 * validation of the model's own output, an exact substring check against text this stage
 * already has, not a text heuristic judging what the relationship means. Nothing here fails
 * the stage: a hallucinated proposal is exactly what this validation exists to catch, not a
 * reason to discard the proposals that check out.
 */
function resolveProposals(
  raw: readonly Proposal[],
  byKey: ReadonlyMap<string, Candidate>,
  maxRelationships: number,
  episodeText: string,
): ResolvedProposal[] {
  const seenPairs = new Set<string>();
  const resolved: ResolvedProposal[] = [];

  for (const proposal of raw) {
    if (resolved.length >= maxRelationships) {
      break;
    }

    const type = proposal.type.trim().toUpperCase();
    if (!isSemanticRelationshipType(type)) {
      continue;
    }

    const source = byKey.get(proposal.source.trim());
    const target = byKey.get(proposal.target.trim());
    if (source === undefined || target === undefined || source.id === target.id) {
      continue;
    }

    const quote = proposal.quote?.trim();
    if (quote === undefined || quote.length === 0 || !episodeText.includes(quote)) {
      continue;
    }

    const pairKey = `${type}:${source.id}:${target.id}`;
    if (seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);

    resolved.push({
      type,
      sourceId: source.id,
      targetId: target.id,
      confidence: clampConfidence(proposal.confidence),
      quote,
    });
  }

  return resolved;
}

export class SemanticRelationshipStage implements ReflectionStage {
  readonly name = SEMANTIC_RELATIONSHIP_STAGE_NAME;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxRelationships: number;

  constructor(options: SemanticRelationshipStageOptions = {}) {
    this.#model = options.model ?? DEFAULTS.models.reflect;
    this.#timeoutMs = options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs;
    this.#maxRelationships = options.maxRelationships ?? DEFAULTS.reflection.maxRelationships;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const text = ctx.episode.text.trim();
    if (text.length === 0) {
      return { status: 'skipped', summary: 'episode has no text to infer relationships from' };
    }

    const [entities, cognitive] = await Promise.all([
      findEpisodeEntities(ctx.driver, ctx.episodeId, ctx.now),
      findEpisodeCognitiveNodes(ctx.driver, ctx.episodeId, ctx.now),
    ]);
    const candidates = buildCandidates(entities, cognitive);
    if (candidates.length < 2) {
      return {
        status: 'skipped',
        summary: 'fewer than two entities or cognitive nodes to relate',
        retryable: true,
      };
    }

    const deadline = deadlineFor(this.#timeoutMs, ctx.signal);
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        model: this.#model,
        messages: buildMessages(text, candidates),
        schema: buildJsonSchema(candidates),
        temperature: RELATIONSHIP_TEMPERATURE,
        // Thinking measurably fixes neither the direction nor the CONTRADICTS false
        // positives this stage is disciplined against below, and costs enough latency to
        // blow the timeout guard outright (qwen3:8b's documented "occasional non-returns").
        // Reasoning buys nothing worth that price, so it stays off (mirrors the entity and
        // cognitive stages).
        think: false,
        signal: deadline.signal,
      });
    } catch (error) {
      return {
        status: 'failed',
        summary: `semantic relationship call ${isAbortError(error) ? 'timed out' : 'failed'}: ${describeError(error)}`,
      };
    } finally {
      deadline.clear();
    }

    const parsed = SemanticRelationshipOutputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'failed',
        summary: `semantic relationship extraction returned an invalid shape: ${formatZodError(parsed.error)}`,
      };
    }

    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const proposals = resolveProposals(
      parsed.data.relationships,
      byKey,
      this.#maxRelationships,
      text,
    );
    if (proposals.length === 0) {
      return {
        status: 'ok',
        summary: `no semantic relationships survived validation across ${candidates.length} candidate(s)`,
        counts: { relationships: 0 },
      };
    }

    let written = 0;
    let writeError: unknown;
    for (const proposal of proposals) {
      try {
        await writeSemanticRelationship(ctx.driver, {
          type: proposal.type,
          sourceId: proposal.sourceId,
          targetId: proposal.targetId,
          confidence: proposal.confidence,
          rationale: proposal.quote,
          now: ctx.now,
        });
        written += 1;
      } catch (error) {
        writeError = error;
        break;
      }
    }

    if (writeError !== undefined) {
      return {
        status: 'failed',
        summary:
          `semantic relationships wrote ${written} of ${proposals.length} edge(s) before a graph ` +
          `write failed: ${describeError(writeError)}`,
        ...(written > 0 ? { counts: { relationships: written } } : {}),
      };
    }

    return {
      status: 'ok',
      summary: `inferred ${written} semantic relationship(s) across ${candidates.length} candidate(s)`,
      counts: { relationships: written },
    };
  }
}
