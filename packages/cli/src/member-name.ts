import { CliUsageError } from './args.js';

export const GIT_USER_NAME_ENV_VAR = 'AION_GIT_USER_NAME';

const MISSING_MEMBER_NAME =
  `no member name available: ${GIT_USER_NAME_ENV_VAR} is empty and there is no terminal to ask on. ` +
  'Set `git config user.name` on the host, or run init from a terminal.';

/**
 * The name the backbone's Member node takes, which is the person this memory belongs to. Its own
 * module because it is the one question init asks that is about the operator rather than about
 * the machine, and because `init.ts` sits at the line cap.
 */
export type MemberNameInput = {
  readonly envName: string | undefined;
  readonly assumeYes: boolean;
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
};

/**
 * `bin/aion` passes `git config user.name` through. Confirming it needs a terminal, so
 * `--yes` and the non-interactive case (the exit gate, CI) take it as given rather than
 * hanging on a prompt nobody can answer.
 */
export async function resolveMemberName(input: MemberNameInput): Promise<string> {
  const fallback = (input.envName ?? '').trim();

  if (input.assumeYes || !input.interactive) {
    if (fallback === '') {
      throw new CliUsageError(MISSING_MEMBER_NAME);
    }
    return fallback;
  }

  const suffix = fallback === '' ? '' : ` [${fallback}]`;
  const answer = (await input.ask(`Member name${suffix}: `)).trim();
  const chosen = answer === '' ? fallback : answer;
  if (chosen === '') {
    throw new CliUsageError(MISSING_MEMBER_NAME);
  }
  return chosen;
}
