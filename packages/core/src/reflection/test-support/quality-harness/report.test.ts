import { describe, expect, it } from 'vitest';

import { renderJsonReport, renderMarkdownReport, type QualityReport } from './report.js';

const FIXED_REPORT: QualityReport = {
  generatedAt: '2026-08-28T00:00:00.000Z',
  routesRun: ['anthropic'],
  routesSkipped: [],
  fixtures: [
    {
      id: 'migration-deadlock',
      title: 'Migration deadlock diagnosis',
      charCount: 512,
      routes: [
        {
          route: 'anthropic',
          model: 'claude-haiku-4-5',
          entities: { ok: true, count: 2, byType: { tool: 1, topic: 1 }, latencyMs: 4200 },
          cognitive: { ok: true, count: 1, byType: { Decision: 1 }, latencyMs: 5100 },
        },
      ],
      agreement: { entityNameOverlap: undefined, cognitiveTextOverlap: 1 },
    },
  ],
};

describe('renderMarkdownReport', () => {
  it('names every fixture, route, count, and latency', () => {
    const markdown = renderMarkdownReport(FIXED_REPORT);

    expect(markdown).toContain('Migration deadlock diagnosis');
    expect(markdown).toContain('`migration-deadlock`');
    expect(markdown).toContain('claude-haiku-4-5');
    expect(markdown).toContain('4200');
    expect(markdown).toContain('5100');
    expect(markdown).toContain('Cognitive node text agreement: 100%');
  });

  it('omits an agreement line the report never computed', () => {
    const markdown = renderMarkdownReport(FIXED_REPORT);

    expect(markdown).not.toContain('Entity name agreement');
  });

  it('renders a skip notice by route and reason', () => {
    const withSkip: QualityReport = {
      ...FIXED_REPORT,
      routesRun: ['anthropic'],
      routesSkipped: [{ route: 'anthropic', reason: 'AION_ANTHROPIC_API_KEY not set' }],
    };

    const markdown = renderMarkdownReport(withSkip);

    expect(markdown).toContain('Routes skipped: anthropic (AION_ANTHROPIC_API_KEY not set)');
  });

  it('lists type breakdowns per route', () => {
    const markdown = renderMarkdownReport(FIXED_REPORT);

    expect(markdown).toContain('- tool: 1');
    expect(markdown).toContain('- topic: 1');
    expect(markdown).toContain('- Decision: 1');
  });
});

describe('renderJsonReport', () => {
  it('round-trips the report exactly', () => {
    const json = renderJsonReport(FIXED_REPORT);

    expect(JSON.parse(json)).toEqual(FIXED_REPORT);
  });
});
