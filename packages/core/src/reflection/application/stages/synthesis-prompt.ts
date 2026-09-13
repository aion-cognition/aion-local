import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import { SYNTHESIS_PROMPT as SYSTEM_PROMPT } from '../../../prompts/synthesis.js';
import {
  premiseTag,
  priorTag,
  SYNTHESIS_INFERENCES,
  type PriorConclusion,
  type SynthesisPremise,
} from '../../domain/synthesis.js';

/**
 * What one synthesis pass shows the model: the memories it selected, and the conclusions already
 * drawn over them. Split out of the stage to keep that file inside the repository's line cap.
 *
 * A prior reaches the model as an interpretation with its own roots named, never as another
 * witness. Two readings of one set of memories are one piece of evidence read twice, and a pass
 * that laid them out as independent would show the model agreement it manufactured.
 */

export const SYNTHESIS_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    conclusions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          premises: { type: 'array', items: { type: 'string' } },
          inference: { type: 'string', enum: [...SYNTHESIS_INFERENCES] },
          revises: { type: 'string' },
          confidence: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['text', 'premises', 'inference'],
      },
    },
  },
  required: ['conclusions'],
};

function renderPremise(premise: SynthesisPremise, index: number): string {
  return `${premiseTag(index)} (${premise.label}): ${premise.text}`;
}

function renderPrior(
  prior: PriorConclusion,
  index: number,
  premises: readonly SynthesisPremise[],
): string {
  const tags = prior.premiseIds
    .map((id) => premises.findIndex((premise) => premise.id === id))
    .filter((position) => position >= 0)
    .map((position) => premiseTag(position));
  const roots = tags.length === 0 ? 'memories outside this set' : tags.join(', ');
  return `${priorTag(index)}: ${prior.text}\n  read from ${roots}`;
}

export function buildMessages(
  premises: readonly SynthesisPremise[],
  priors: readonly PriorConclusion[],
): ChatMessage[] {
  const memories = premises.map((premise, index) => renderPremise(premise, index)).join('\n');
  const drawn =
    priors.length === 0
      ? ''
      : `\n\nConclusions already drawn over these memories:\n${priors
          .map((prior, index) => renderPrior(prior, index, premises))
          .join('\n')}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Memories:\n${memories}${drawn}` },
  ];
}
