import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The file a harness keeps its hooks in: where it sits, reading it, copying it aside, and
 * writing it back. `settings.ts` decides what belongs in the hooks block; this touches the
 * disk. The install command and the hook client both write this file, so they share one
 * implementation and the backup rule holds whichever of them wrote.
 */

export function claudeSettingsPath(home: string): string {
  return join(home, '.claude', 'settings.json');
}

/** Codex keeps its own directory, which `CODEX_HOME` moves the way `HOME` moves a home directory. */
export function codexHooksPath(home: string, env: NodeJS.ProcessEnv): string {
  const configured = (env.CODEX_HOME ?? '').trim();
  return join(configured === '' ? join(home, '.codex') : configured, 'hooks.json');
}

export class SettingsUnreadableError extends Error {
  constructor(path: string, reason: string, options?: { cause?: unknown }) {
    super(`${path} ${reason}; fix or move it before installing hooks`, options);
    this.name = 'SettingsUnreadableError';
  }
}

/** Compact UTC, so a directory listing sorts the backups in the order they were taken. */
export function backupPath(settingsPath: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${settingsPath}.aion-${stamp}`;
}

export function readSettings(path: string): unknown {
  if (!existsSync(path)) {
    return {};
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SettingsUnreadableError(path, 'could not be read', { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new SettingsUnreadableError(path, 'is not valid JSON', { cause: err });
  }
}

/**
 * Nothing is written until the current file is copied aside, so a bad merge is always one `mv`
 * from undone. The copy it made comes back so the caller can name it; nothing to copy answers
 * undefined.
 */
export function backupSettings(path: string, now: Date): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const target = backupPath(path, now);
  // Two commands inside the same second would name the same copy. The first one holds the
  // older state, which is the one worth keeping, so it is never overwritten.
  if (existsSync(target)) {
    return undefined;
  }
  copyFileSync(path, target);
  return target;
}

export function writeSettings(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
