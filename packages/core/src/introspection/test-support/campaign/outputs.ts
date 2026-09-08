import { existsSync, writeFileSync } from 'node:fs';

/**
 * Campaign outputs are written once and never replaced.
 *
 * A manifest records what one run froze. A second invocation writing over it would leave two
 * runs claiming one immutable record, and nothing afterwards could say which membership a
 * comparison was made against. So each run writes under its own identity and a path already
 * taken is refused rather than overwritten.
 */

export class OutputAlreadyWritten extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`${path} already exists; each run writes under its own identity`);
    this.name = 'OutputAlreadyWritten';
    this.path = path;
  }
}

export function writeOnce(path: string, value: unknown): void {
  if (existsSync(path)) {
    throw new OutputAlreadyWritten(path);
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
