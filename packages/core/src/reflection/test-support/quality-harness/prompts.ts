import { z } from 'zod';
import type { ChatMessage, JsonSchema } from '../../../infrastructure/providers/types.js';
import { COGNITIVE_TYPES, ENTITY_TYPES } from './types.js';

export const ENTITY_EXTRACTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ENTITY_TYPES },
        },
        required: ['name', 'type'],
      },
    },
  },
  required: ['entities'],
};

export const EntityExtractionOutputSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().min(1),
      type: z.enum(ENTITY_TYPES),
    }),
  ),
});

export const COGNITIVE_EXTRACTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: COGNITIVE_TYPES },
          name: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['type', 'name', 'description'],
      },
    },
  },
  required: ['nodes'],
};

export const CognitiveExtractionOutputSchema = z.object({
  nodes: z.array(
    z.object({
      type: z.enum(COGNITIVE_TYPES),
      name: z.string().min(1),
      description: z.string().min(1),
    }),
  ),
});

const ENTITY_EXTRACTION_SYSTEM_PROMPT = [
  'You extract named entities from a memory episode recorded by an AI coding agent.',
  `An entity is a person, organization, project, tool, concept, location, or event explicitly present in the text.`,
  'Use the entity\'s most specific mentioned name. Do not invent an entity that the text does not name.',
  'Return each distinct entity once.',
].join(' ');

const COGNITIVE_EXTRACTION_SYSTEM_PROMPT = [
  'You extract cognitive structure from a memory episode recorded by an AI coding agent:',
  'goals, plans, decisions, insights, concepts, contexts, events, patterns, and trends the episode actually contains.',
  'Give each node a type from that list, a short name (a few words), and a one-sentence description grounded in the text.',
  'Skip a type with no evidence in the episode; do not pad the output to cover every type.',
].join(' ');

export function buildEntityExtractionMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: ENTITY_EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: `Episode:\n${text}` },
  ];
}

export function buildCognitiveExtractionMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: COGNITIVE_EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: `Episode:\n${text}` },
  ];
}
