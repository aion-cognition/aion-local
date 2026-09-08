import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OutputAlreadyWritten, writeOnce } from './outputs.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aion-campaign-outputs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writing a campaign output', () => {
  it('writes the record it was given', () => {
    const path = join(dir, 'manifest.json');
    writeOnce(path, { manifestId: 'abc' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ manifestId: 'abc' });
  });

  it('refuses a second run writing over the first', () => {
    const path = join(dir, 'manifest.json');
    writeOnce(path, { manifestId: 'first' });
    expect(() => {
      writeOnce(path, { manifestId: 'second' });
    }).toThrow(OutputAlreadyWritten);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ manifestId: 'first' });
  });
});
