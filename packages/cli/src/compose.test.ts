import { describe, expect, it } from 'vitest';
import { composeRunner, ComposeCommandError, startService, type ComposeRunner } from './compose.js';

describe('startService', () => {
  it('brings up exactly the named service, detached', async () => {
    const calls: string[][] = [];
    const run: ComposeRunner = async (args) => {
      calls.push([...args]);
      return '';
    };

    await startService(run, 'neo4j');

    expect(calls).toEqual([['up', '-d', 'neo4j']]);
  });
});

describe('composeRunner', () => {
  it('reports a failed compose invocation as a named error carrying the command', async () => {
    const run = composeRunner('/nonexistent-repo-for-test');

    await expect(run(['up', '-d', 'neo4j'])).rejects.toBeInstanceOf(ComposeCommandError);
  });
});
