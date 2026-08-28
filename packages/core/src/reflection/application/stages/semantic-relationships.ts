import { z } from 'zod';
import { findEpisodeEntities, type EpisodeEntity } from '../../../infrastructure/graph/entity-queries.js';
import {
  findEpisodeCognitiveNodes,
  isSemanticRelationshipType,
  writeSemanticRelationship,
  SEMANTIC_RELATIONSHIP_TYPES,
  type EpisodeCognitiveNode,
  type SemanticRelationshipType,
} from '../../../infrastructure/graph/semantic-relationship-queries.js';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import type { ReflectionStage, StageContext, StageOutcome } from '../../domain/stage.js';

/**
 * Whitepaper §6.8 / Algorithm 4 step 7: one structured-output call per episode proposing
 * typed edges between the entities and cognitive structures the two prior stages already
 * extracted. This stage reads both sets fresh from the graph rather than assuming either
 * stage ran in this pass — an episode enriched before entity or cognitive extraction landed,
 * or one where either stage failed in isolation, simply has fewer candidates to relate.
 */

export const SEMANTIC_RELATIONSHIP_STAGE_NAME = 'semantic-relationships';

/** `config.models.reflect`'s pinned default; the Integration task threads the configured value in. */
export const DEFAULT_SEMANTIC_RELATIONSHIP_MODEL = 'qwen3:8b';

/** qwen3:8b with thinking on measured 10-44s with occasional non-returns; the guard, not a target. */
export const DEFAULT_SEMANTIC_RELATIONSHIP_TIMEOUT_MS = 60_000;

/** One episode's worth of typed edges; a model that returns more is padding, not reading. */
export const DEFAULT_MAX_RELATIONSHIPS = 40;

export type SemanticRelationshipStageOptions = {
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRelationships?: number;
};

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
    candidates.push({ key: `E${index + 1}`, id: entity.id, label: `${entity.name} (${entity.type})` });
  });
  cognitive.forEach((node, index) => {
    candidates.push({ key: `C${index + 1}`, id: node.id, label: `[${node.label}] ${node.text}` });
  });
  return candidates;
}

const SYSTEM_PROMPT = [
  'You infer typed relationships between the entities and cognitive structures already',
  'extracted from one episode. Each item below carries a key; refer to items only by that',
  'key, never by its label, and never relate an item to itself.',
  'Use CAUSES when one item caused another, ENABLES when one item made another possible,',
  'PRECEDES when one item happened before another in a way that matters, CONTRADICTS when',
  'two items are in tension and cannot both hold, SIMILAR when two items mean close to the',
  'same thing, RELATED_TO when two items are meaningfully connected but no other type fits,',
  'and ANALOGOUS_TO when two items are similar in kind without one causing, enabling, or',
  'preceding the other.',
  'Give each relationship a confidence between 0 and 1 for how sure the episode makes you,',
  'and a one-clause rationale grounded in the episode. Propose only relationships the episode',
  'actually supports; return an empty list rather than a weak guess.',
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
            rationale: { type: 'string' },
          },
          required: ['source', 'target', 'type', 'confidence'],
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
  rationale: z.string().optional(),
});

type Proposal = z.infer<typeof ProposalSchema>;

const SemanticRelationshipOutputSchema = z.object({
  relationships: z.array(ProposalSchema),
});

/** Applied only when the model omits the (optional) field; a genuine answer never needs it. */
const DEFAULT_PROPOSAL_CONFIDENCE = 0.5;

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
  readonly rationale?: string;
};

/**
 * Every drop here is a hallucination guard: a key the candidate list never issued, a
 * self-loop, a type outside the sanctioned five, or a pair this same run already proposed.
 * Nothing here fails the stage — a hallucinated proposal is exactly what §6.8 asks this
 * validation to catch, not a reason to discard the proposals that check out.
 */
function resolveProposals(
  raw: readonly Proposal[],
  byKey: ReadonlyMap<string, Candidate>,
  maxRelationships: number,
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

    const pairKey = `${type}:${source.id}:${target.id}`;
    if (seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);

    const rationale = proposal.rationale?.trim();
    resolved.push({
      type,
      sourceId: source.id,
      targetId: target.id,
      confidence: clampConfidence(proposal.confidence),
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
    });
  }

  return resolved;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class SemanticRelationshipStage implements ReflectionStage {
  readonly name = SEMANTIC_RELATIONSHIP_STAGE_NAME;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxRelationships: number;

  constructor(options: SemanticRelationshipStageOptions = {}) {
    this.#model = options.model ?? DEFAULT_SEMANTIC_RELATIONSHIP_MODEL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SEMANTIC_RELATIONSHIP_TIMEOUT_MS;
    this.#maxRelationships = options.maxRelationships ?? DEFAULT_MAX_RELATIONSHIPS;
  }

  async run(ctx: StageContext): Promise<StageOutcome> {
    const text = ctx.episode.text.trim();
    if (text.length === 0) {
      return { status: 'skipped', summary: 'episode has no text to infer relationships from' };
    }

    const [entities, cognitive] = await Promise.all([
      findEpisodeEntities(ctx.driver, ctx.episodeId),
      findEpisodeCognitiveNodes(ctx.driver, ctx.episodeId),
    ]);
    const candidates = buildCandidates(entities, cognitive);
    if (candidates.length < 2) {
      return { status: 'skipped', summary: 'fewer than two entities or cognitive nodes to relate' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let raw: unknown;
    try {
      raw = await ctx.provider.generate({
        model: this.#model,
        messages: buildMessages(text, candidates),
        schema: buildJsonSchema(candidates),
        // Reasoning buys nothing on a structured relation call and costs the budget (mirrors
        // the entity and cognitive stages).
        think: false,
        signal: controller.signal,
      });
    } catch (error) {
      return {
        status: 'failed',
        summary: `semantic relationship call ${isAbortError(error) ? 'timed out' : 'failed'}: ${describeError(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }

    const parsed = SemanticRelationshipOutputSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 'failed',
        summary: `semantic relationship extraction returned an invalid shape: ${formatZodError(parsed.error)}`,
      };
    }

    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const proposals = resolveProposals(parsed.data.relationships, byKey, this.#maxRelationships);
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
          now: ctx.now,
          ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
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
