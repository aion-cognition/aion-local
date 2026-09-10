import type { Driver } from 'neo4j-driver';
import { expect, it } from 'vitest';

import {
  chunkMemberUnits,
  renderSealedChunk,
  selectSubmittedRanges,
  type ChunkMemberText,
} from './chunk-render.js';
import { planChunkInput } from './chunk-revision.js';
import { synthesizeChunk } from '../application/chunk-synthesis.js';

const member: ChunkMemberText = {
  sourceId: 'member',
  text: 'a'.repeat(300),
  parts: [{ address: 'part:member:turn:0', text: 'a'.repeat(300) }],
};

it('charges separators before choosing the next partial range', () => {
  const input: ChunkMemberText = {
    sourceId: 'source',
    text: 'aaaaa\nbbbbb',
    parts: [
      { address: 'first', text: 'aaaaa' },
      { address: 'second', text: 'bbbbb' },
    ],
  };
  const ranges = selectSubmittedRanges(input, 9);
  const bytes = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  expect(bytes + Math.max(0, ranges.length - 1)).toBeLessThanOrEqual(9);
});

it('blocks or reserves the full transition input beside an oversized member', () => {
  const transition: ChunkMemberText = {
    sourceId: 'correction',
    text: 'required correction '.repeat(9),
    parts: [],
  };
  const allowance = 120;
  const plan = planChunkInput({
    members: [{ sourceId: member.sourceId, reading: 'complete', text: member }],
    transition: [{ sourceId: transition.sourceId, reading: 'complete', text: transition }],
    oversizedMember: member.sourceId,
    allowance,
  });
  if (plan.status === 'block') {
    return;
  }
  const rendered = renderSealedChunk({
    members: [...plan.members, ...plan.transition],
    enrichment: [],
    allowance,
    boundedPartialOf: plan.boundedPartialOf,
  });
  expect(rendered.source.text).toContain(transition.text);
  expect(rendered.renderedUnits).toBeLessThanOrEqual(allowance);
});

it('spends no generation when an oversized member has no admissible raw passage', async () => {
  const allowance = chunkMemberUnits(0, { ...member, text: '' });
  const plan = planChunkInput({
    members: [{ sourceId: member.sourceId, reading: 'complete', text: member }],
    oversizedMember: member.sourceId,
    allowance,
  });
  if (plan.status === 'block') {
    return;
  }
  let calls = 0;
  await synthesizeChunk(
    {
      driver: { executeQuery: async () => ({ records: [] }) } as unknown as Driver,
      provider: {
        embed: async () => {
          throw new Error('no embedding');
        },
        generate: async () => {
          calls += 1;
          return { sentences: [] };
        },
      },
    },
    { sessionId: 'session', plan, allowance, now: new Date('2026-09-01T00:00:00Z') },
  ).catch(() => undefined);
  expect(calls).toBe(0);
});

it('control: complete members render whole inside an exactly matched allowance', () => {
  const allowance = chunkMemberUnits(0, member);
  const rendered = renderSealedChunk({ members: [member], enrichment: [], allowance });
  expect(rendered.source.text).toContain(member.text);
  expect(rendered.complete).toBe(true);
  expect(rendered.renderedUnits).toBe(allowance);
});

it('control: the same synthesis fixture executes generation on nonempty admitted raw input', async () => {
  const allowance = chunkMemberUnits(0, member);
  const plan = planChunkInput({
    members: [{ sourceId: member.sourceId, reading: 'complete', text: member }],
    allowance,
  });
  expect(plan.status).toBe('render');
  if (plan.status !== 'render') {
    throw new Error('control needs admitted input');
  }
  let calls = 0;
  const result = await synthesizeChunk(
    {
      driver: { executeQuery: async () => ({ records: [] }) } as unknown as Driver,
      provider: {
        embed: async () => {
          throw new Error('no embedding');
        },
        generate: async () => {
          calls += 1;
          return { sentences: [{ text: 'a source was recorded', source_ids: ['S1'] }] };
        },
      },
    },
    { sessionId: 'session', plan, allowance, now: new Date('2026-09-01T00:00:00Z') },
  );
  expect(calls).toBe(1);
  expect(result.output.kept).toBe(1);
});
