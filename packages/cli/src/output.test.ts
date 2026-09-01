import { createInterface } from 'node:readline/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { confirmOrExit } from './output.js';

vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => lines.push(line) };
}

/** `Object.defineProperty` restores the real descriptor: `process.stdin.isTTY` is not writable directly. */
function withTTY(value: boolean, run: () => Promise<void>): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  return run().finally(() => {
    if (original !== undefined) {
      Object.defineProperty(process.stdin, 'isTTY', original);
    }
  });
}

describe('confirmOrExit', () => {
  afterEach(() => {
    vi.mocked(createInterface).mockReset();
  });

  it('skips the ask when assumeYes is set, whatever stdin is', async () => {
    const { lines, write } = collector();

    expect(await confirmOrExit('go ahead? [y/N] ', true, write)).toBe(true);

    expect(lines).toEqual([]);
    expect(createInterface).not.toHaveBeenCalled();
  });

  it('refuses with no terminal to confirm on, and never opens readline', () =>
    withTTY(false, async () => {
      const { lines, write } = collector();

      expect(await confirmOrExit('go ahead? [y/N] ', false, write)).toBe(false);

      expect(lines.join('\n')).toContain('--yes');
      expect(createInterface).not.toHaveBeenCalled();
    }));

  it('asks on a real terminal and reads y or yes, trimmed and case-insensitive', () =>
    withTTY(true, async () => {
      const question = vi.fn().mockResolvedValue('  Y  ');
      const close = vi.fn();
      vi.mocked(createInterface).mockReturnValue({
        question,
        close,
      } as unknown as ReturnType<typeof createInterface>);

      expect(await confirmOrExit('drop it? [y/N] ', false, collector().write)).toBe(true);

      expect(question).toHaveBeenCalledWith('drop it? [y/N] ');
      expect(close).toHaveBeenCalled();
    }));

  it('refuses anything that is not y or yes', () =>
    withTTY(true, async () => {
      vi.mocked(createInterface).mockReturnValue({
        question: vi.fn().mockResolvedValue('nope'),
        close: vi.fn(),
      } as unknown as ReturnType<typeof createInterface>);

      expect(await confirmOrExit('drop it? [y/N] ', false, collector().write)).toBe(false);
    }));
});
