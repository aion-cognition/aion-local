import { describe, expect, it } from 'vitest';

import { plannedConclusions } from './synthesis.js';

describe('the model owns the conclusion within the evidence it was shown', () => {
  const premises = [
    { id: 'fresh', label: 'Insight', text: 'A new run retried once', revision: 1, changed: true },
    {
      id: 'old-a',
      label: 'Insight',
      text: 'Retries always cluster after deployments',
      revision: 1,
      changed: false,
    },
    {
      id: 'old-b',
      label: 'Insight',
      text: 'Deployments clear the page cache',
      revision: 1,
      changed: false,
    },
  ];
  it('retains a novel grounded conclusion about two shown older premises', () => {
    const plan = plannedConclusions(
      [
        {
          text: 'Cold cache may explain the deployment-associated retry pattern',
          premises: ['M2', 'M3'],
          inference: 'new',
          confidence: 0.6,
        },
      ],
      { premises, priors: [], max: 3 },
    );
    expect(plan.refused).toEqual([]);
    expect(plan.conclusions).toHaveLength(1);
  });
  it('still rejects a conclusion with no shown premise', () => {
    const plan = plannedConclusions(
      [
        {
          text: 'An invented account',
          premises: ['M99'],
          inference: 'new',
        },
      ],
      { premises, priors: [], max: 3 },
    );
    expect(plan.conclusions).toHaveLength(0);
    expect(plan.refused).toHaveLength(1);
  });
});
