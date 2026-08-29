import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_NAME, run } from './run.js';

describe('run', () => {
  let dir: string;
  let logFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aion-cli-'));
    logFile = join(dir, 'aion.jsonl');
    process.env['AION_LOG_FILE'] = logFile;
  });

  afterEach(() => {
    delete process.env['AION_LOG_FILE'];
    delete process.env['AION_LOG_LEVEL'];
    delete process.env['AION_NOT_A_KNOB'];
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints usage for --help and exits 0', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await expect(run(['--help'])).resolves.toBe(0);

    expect(stdout).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]?.[0]).toContain(`usage: ${CLI_NAME} <command> [options]`);
  });

  it('prints usage when invoked with no arguments', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await expect(run([])).resolves.toBe(0);

    expect(stdout.mock.calls[0]?.[0]).toContain('commands:');
  });

  it('lists init, status, and doctor in the usage text', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await run(['help']);

    const text = String(stdout.mock.calls[0]?.[0]);
    for (const command of ['init', 'status', 'doctor']) {
      expect(text).toContain(command);
    }
  });

  it('lists stats, why, search, and forget in the usage text', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await run(['help']);

    const text = String(stdout.mock.calls[0]?.[0]);
    for (const command of ['stats', 'why', 'search', 'forget']) {
      expect(text).toContain(command);
    }
  });

  it('reports an unknown command on stderr and exits 1', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(run(['nope'])).resolves.toBe(1);

    expect(stderr.mock.calls[0]?.[0]).toContain("unknown command 'nope'");
  });

  it('reads no environment of its own, so a bad AION_* value cannot slip past config', async () => {
    process.env['AION_LOG_LEVEL'] = 'totally-bogus';
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await expect(run(['help'])).resolves.toBe(0);

    expect(existsSync(logFile)).toBe(false);
    expect(stdout).toHaveBeenCalledOnce();
  });

  it('leaves an unknown AION_* variable for the command to reject', async () => {
    process.env['AION_NOT_A_KNOB'] = 'nonsense';
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(run(['init'])).resolves.toBe(1);

    expect(stderr.mock.calls[0]?.[0]).toContain('AION_NOT_A_KNOB');
  });
});
