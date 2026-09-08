import { expect, it } from 'vitest';

import { evaluateInterval } from './interval.js';

const before = new Date('2026-09-08T09:00:00.000Z');
const end = '2026-09-08T10:00:00.000Z';
const after = new Date('2026-09-08T11:00:00.000Z');

it('does not let a world end establish missing knowledge-end proof', () => {
  expect(
    evaluateInterval({ closed: true, validUntil: end }, { validAt: before, knownAt: before }),
  ).toEqual({ status: 'unknown', axis: 'knowledge' });
});

it('does not let a knowledge end establish missing world-end proof', () => {
  expect(
    evaluateInterval({ closed: true, txUntil: end }, { validAt: before, knownAt: before }),
  ).toEqual({ status: 'unknown', axis: 'world' });
});

it('keeps proved world exclusion decisive despite missing knowledge-end proof', () => {
  expect(
    evaluateInterval({ closed: true, validUntil: end }, { validAt: after, knownAt: before }),
  ).toEqual({ status: 'excluded' });
});

it('keeps proved knowledge exclusion decisive despite missing world-end proof', () => {
  expect(
    evaluateInterval({ closed: true, txUntil: end }, { validAt: before, knownAt: after }),
  ).toEqual({ status: 'excluded' });
});
