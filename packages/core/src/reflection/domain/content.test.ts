import { describe, expect, it } from 'vitest';
import {
  hashContent,
  prepareEpisode,
  renderEpisodeText,
  stableStringify,
  type ReflectionContent,
} from './content.js';

const MIXED: ReflectionContent = {
  turns: [
    { role: 'user', text: 'why webhooks?' },
    { role: 'assistant', text: 'polling cost too much' },
  ],
  tool_executions: [
    { tool: 'bash', input: 'npm test', status: 'error', output: 'exit 1', duration_ms: 8200 },
  ],
  observations: ['We keyed the sync on id_slug'],
  summary: 'ingestion design',
};

describe('stableStringify', () => {
  it('is invariant to object key order at every depth', () => {
    const a = { b: { d: 1, c: [{ f: 2, e: 3 }] }, a: 4 };
    const b = { a: 4, b: { c: [{ e: 3, f: 2 }], d: 1 } };

    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('keeps array order, which is content, not layout', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });
});

describe('hashContent', () => {
  it('is stable across calls and sensitive to any content change', () => {
    expect(hashContent(MIXED)).toBe(hashContent({ ...MIXED }));
    expect(hashContent(MIXED)).not.toBe(hashContent({ ...MIXED, summary: 'other' }));
  });
});

describe('renderEpisodeText', () => {
  it('renders turns, tool executions, and observations into one episode body', () => {
    expect(renderEpisodeText(MIXED)).toBe(
      [
        'summary: ingestion design',
        'user: why webhooks?',
        'assistant: polling cost too much',
        'tool bash [error, 8200ms]',
        'input: npm test',
        'output: exit 1',
        'observation: We keyed the sync on id_slug',
      ].join('\n'),
    );
  });

  it('serializes structured tool input and output canonically', () => {
    const text = renderEpisodeText({
      tool_executions: [
        { tool: 'http', input: { url: 'x', method: 'GET' }, status: 'ok', output: { code: 200 }, duration_ms: 12 },
      ],
    });

    expect(text).toContain('input: {"method":"GET","url":"x"}');
    expect(text).toContain('output: {"code":200}');
  });

  it('omits what a tool execution did not carry rather than rendering it empty', () => {
    const text = renderEpisodeText({ tool_executions: [{ tool: 'bash', status: 'ok' }] });

    expect(text).toBe('tool bash [ok]');
  });

  it('keeps the fields a partial tool execution did carry', () => {
    const text = renderEpisodeText({
      tool_executions: [{ tool: 'read', input: 'src/index.ts', status: 'ok' }],
    });

    expect(text).toBe(['tool read [ok]', 'input: src/index.ts'].join('\n'));
  });

  it('renders an observations-only payload, which carries no turns at all', () => {
    expect(renderEpisodeText({ observations: ['ship it'] })).toBe('observation: ship it');
  });
});

describe('prepareEpisode', () => {
  const now = new Date('2026-08-27T12:00:00.000Z');

  it('numbers turns in payload order and counts every content kind', () => {
    const prepared = prepareEpisode(MIXED, now);

    expect(prepared.turns.map((turn) => turn.sequence)).toEqual([0, 1]);
    expect(prepared.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(prepared).toMatchObject({ turnCount: 2, toolExecutionCount: 1, observationCount: 1 });
  });

  it('takes occurred_at from the earliest payload timestamp when one is present', () => {
    const prepared = prepareEpisode(
      {
        turns: [
          { role: 'user', text: 'later', occurred_at: '2026-03-02T10:00:00Z' },
          { role: 'assistant', text: 'earlier', occurred_at: '2026-03-01T10:00:00Z' },
        ],
      },
      now,
    );

    expect(prepared.occurredAt.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(prepared.turns[0]?.occurredAt.toISOString()).toBe('2026-03-02T10:00:00.000Z');
  });

  it('falls back to the intake clock, and an untimestamped turn inherits the episode time', () => {
    const prepared = prepareEpisode({ observations: ['no clock here'] }, now);
    const withTurn = prepareEpisode({ turns: [{ role: 'user', text: 'hi' }] }, now);

    expect(prepared.occurredAt).toEqual(now);
    expect(withTurn.turns[0]?.occurredAt).toEqual(now);
  });

  it('gives each turn its own content hash', () => {
    const prepared = prepareEpisode(MIXED, now);
    const hashes = new Set(prepared.turns.map((turn) => turn.contentHash));

    expect(hashes.size).toBe(2);
  });
});
