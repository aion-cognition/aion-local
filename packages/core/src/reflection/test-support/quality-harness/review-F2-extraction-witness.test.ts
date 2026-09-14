import { expect, it } from 'vitest';
import { summarizeEntities } from './scorer.js';
import { extractEntitiesViaProvider } from './provider-extractor.js';
import { GenerationCeilingReachedError } from '../../../infrastructure/providers/errors.js';

it('shows why counts and schema validity cannot establish extraction faithfulness', () => {
  const faithful = {
    ok: true as const,
    latencyMs: 1,
    value: { entities: [{ name: 'Redis', type: 'tool' as const }] },
  };
  const invented = {
    ok: true as const,
    latencyMs: 1,
    value: { entities: [{ name: 'An unrelated invented product', type: 'tool' as const }] },
  };
  const good = summarizeEntities(faithful);
  const bad = summarizeEntities(invented);
  console.log(JSON.stringify({ witness: 'faithfulness-lost', faithful, invented, good, bad }));
  // Affirmative witness of the loss in the current live root's only retained value.
  // This is not a prescription to change this general-purpose metrics helper.
  expect(good).toEqual(bad);
});
it('shows that the live root must distinguish a budget refusal from a model answer', async () => {
  const outcome = await extractEntitiesViaProvider(
    {
      model: 'claude-haiku-4-5',
      generate: async () => {
        throw new GenerationCeilingReachedError('entities', 5, 5);
      },
    },
    'Redis is our cache.',
  );
  const metrics = summarizeEntities(outcome);
  console.log(JSON.stringify({ witness: 'refusal-is-not-schema-invalidity', outcome, metrics }));
  expect(outcome.ok).toBe(false);
});
