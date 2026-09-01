import { createInterface } from 'node:readline/promises';

export type Writer = (line: string) => void;

export function stdoutWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function stderrWriter(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The one confirm gate every destructive verb calls before it writes. `assumeYes` (`--yes`)
 * skips the ask outright; with no terminal to ask on, `--yes` is the only way through, so a
 * script or a piped invocation never blocks on a question nothing will answer.
 */
export async function confirmOrExit(
  prompt: string,
  assumeYes: boolean,
  write: Writer,
): Promise<boolean> {
  if (assumeYes) {
    return true;
  }
  if (!process.stdin.isTTY) {
    write('re-run with --yes (no terminal to confirm on)');
    return false;
  }
  const answer = (await askOnTerminal(prompt)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/** Named errors carry the diagnosis in `name`; losing it would turn a precise failure into a generic one. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
