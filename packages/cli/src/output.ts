export type Writer = (line: string) => void;

export function stdoutWriter(line: string): void {
  process.stdout.write(`${line}\n`);
}

export function stderrWriter(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Named errors carry the diagnosis in `name`; losing it would turn a precise failure into a generic one. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
