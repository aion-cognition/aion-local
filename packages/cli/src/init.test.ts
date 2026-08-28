import { describe, expect, it } from 'vitest';
import {
  MemberNameUnavailableError,
  parseInitFlags,
  registrationCommand,
  registrationJson,
  resolveMemberName,
  UnknownOptionError,
} from './init.js';

const never = async (): Promise<string> => {
  throw new Error('prompt must not run');
};

describe('parseInitFlags', () => {
  it('defaults to interactive confirmation', () => {
    expect(parseInitFlags([])).toEqual({ assumeYes: false });
  });

  it('accepts --yes and -y', () => {
    expect(parseInitFlags(['--yes']).assumeYes).toBe(true);
    expect(parseInitFlags(['-y']).assumeYes).toBe(true);
  });

  it('rejects an unknown option', () => {
    expect(() => parseInitFlags(['--force'])).toThrow(UnknownOptionError);
  });
});

describe('resolveMemberName', () => {
  it('takes the git name as-is without a terminal', async () => {
    await expect(
      resolveMemberName({ envName: 'Ryan Huber', assumeYes: false, interactive: false, ask: never }),
    ).resolves.toBe('Ryan Huber');
  });

  it('takes the git name as-is under --yes even on a terminal', async () => {
    await expect(
      resolveMemberName({ envName: 'Ryan Huber', assumeYes: true, interactive: true, ask: never }),
    ).resolves.toBe('Ryan Huber');
  });

  it('offers the git name as the prompt default and keeps it on an empty answer', async () => {
    const questions: string[] = [];
    const name = await resolveMemberName({
      envName: 'Ryan Huber',
      assumeYes: false,
      interactive: true,
      ask: async (question) => {
        questions.push(question);
        return '\n';
      },
    });

    expect(name).toBe('Ryan Huber');
    expect(questions[0]).toContain('[Ryan Huber]');
  });

  it('prefers the typed answer over the git name', async () => {
    await expect(
      resolveMemberName({ envName: 'Ryan Huber', assumeYes: false, interactive: true, ask: async () => '  Someone Else ' }),
    ).resolves.toBe('Someone Else');
  });

  it('fails by name when there is nothing to fall back to and no terminal', async () => {
    await expect(
      resolveMemberName({ envName: '  ', assumeYes: false, interactive: false, ask: never }),
    ).rejects.toBeInstanceOf(MemberNameUnavailableError);
  });

  it('fails when the terminal answer is empty and there is no git name', async () => {
    await expect(
      resolveMemberName({ envName: undefined, assumeYes: false, interactive: true, ask: async () => '' }),
    ).rejects.toBeInstanceOf(MemberNameUnavailableError);
  });
});

describe('registrationCommand', () => {
  it('writes the exact one-time command PRD §11 specifies', () => {
    expect(registrationCommand(8765)).toBe(
      'claude mcp add -s user --transport http aion http://127.0.0.1:8765/mcp',
    );
  });
});

describe('registrationJson', () => {
  it('matches the shape Claude Code writes for an HTTP MCP server', () => {
    expect(JSON.parse(registrationJson(8765))).toEqual({
      mcpServers: { aion: { type: 'http', url: 'http://127.0.0.1:8765/mcp' } },
    });
  });
});
