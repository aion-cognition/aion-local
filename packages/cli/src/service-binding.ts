import {
  describeError,
  openExistingSqliteHandle,
  readSubstratePairing,
  sqliteTableExists,
  type SqliteHandle,
} from '@aion/core';
import { existsSync } from 'node:fs';

import type { HostActions } from './host-actions.js';
import { MCP_LAUNCH_LABEL } from './launchd.js';

/**
 * Who is actually serving the port, and whether it is this installation's service.
 *
 * A matching plist on disk and a 200 from `/health` prove neither. A process whose store file was
 * deleted out from under it keeps the handle, keeps the port and keeps answering, and every one of
 * those facts stays true while the substrate at the configured path goes unserved. The facts that
 * do decide it are here: the pid launchd names for our job, the pid holding the port, the build
 * the answering process runs, and the id of the store it has open.
 *
 * Nothing in this file stops, signals or kills a process. A port owner that is not ours is named
 * and left alone.
 */

export function launchdDomain(): string {
  return `gui/${String(process.getuid?.() ?? 0)}`;
}

/**
 * A host reading that either happened or did not.
 *
 * An unsuccessful command is not an observation of absence. `launchctl`, `ps` and `lsof` all fail
 * for reasons that have nothing to do with what they were asked about, and reading those failures
 * as "nothing there" is the same mistake one level down as reading a failed `bootout` as a stopped
 * service. Callers that must prove something is gone have to see `known` first.
 */
export type Observed<T> =
  { readonly known: true; readonly value: T } | { readonly known: false; readonly reason: string };

/** The sentinel a job carries when nothing computed a build sha for it. */
export const UNSTAMPED_BUILD = 'unstamped';

/** A sha names a build; the sentinel and an empty string name the absence of one. */
export function isRealBuildSha(sha: string | undefined): sha is string {
  return sha !== undefined && sha.trim() !== '' && sha !== UNSTAMPED_BUILD;
}

export type LaunchdJobState = {
  /** Whether launchd still knows the label. A booted-out job is gone from the domain. */
  readonly loaded: boolean;
  /** The process launchd names for it, when it names one. */
  readonly pid: number | undefined;
};

/** `launchctl print` prints `pid = N` for a job with a running process and omits it otherwise. */
function parseJobPid(printed: string): number | undefined {
  const match = /^\s*pid\s*=\s*(\d+)/m.exec(printed);
  if (match?.[1] === undefined) {
    return undefined;
  }
  return Number.parseInt(match[1], 10);
}

/**
 * The one failure that is a reading. `launchctl print` on a label the domain does not hold says
 * so; a denied privilege, a missing domain or a broken pipe say something else entirely, and none
 * of those mean the job is gone.
 */
function saysNoSuchJob(stderr: string): boolean {
  return /could not find|no such (process|service)/i.test(stderr);
}

export async function readLaunchdJob(
  actions: HostActions,
  label: string = MCP_LAUNCH_LABEL,
): Promise<Observed<LaunchdJobState>> {
  const printed = await actions.run('launchctl', ['print', `${launchdDomain()}/${label}`]);
  if (printed.ok) {
    return { known: true, value: { loaded: true, pid: parseJobPid(printed.stdout) } };
  }
  if (saysNoSuchJob(printed.stderr)) {
    return { known: true, value: { loaded: false, pid: undefined } };
  }
  return { known: false, reason: printed.stderr.trim() || 'launchctl print failed' };
}

/**
 * The pids listening on the port. `-t` asks lsof for pids alone, one per line.
 *
 * lsof exits non-zero with no output when its filter matches nothing, which is the ordinary "no
 * listener" reading rather than a failure; anything it writes to stderr is the other case. Pids
 * are deduplicated because one process holding both the v4 and the v6 socket is listed for each.
 */
export async function readListenerPids(
  actions: HostActions,
  port: number,
): Promise<Observed<readonly number[]>> {
  const listed = await actions.run('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-t']);
  if (!listed.ok && listed.stderr.trim() !== '') {
    return { known: false, reason: listed.stderr.trim() };
  }
  const pids = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map((line) => Number.parseInt(line, 10));
  return { known: true, value: [...new Set(pids)] };
}

/**
 * What a live process is running, or `undefined` when there is no such process. This is the
 * liveness test as well as the identification: `ps -p` prints nothing and exits non-zero for a pid
 * that has exited, while a `ps` that could not be run at all says so on stderr and settles
 * nothing.
 */
export async function readProcessCommand(
  actions: HostActions,
  pid: number,
): Promise<Observed<string | undefined>> {
  const shown = await actions.run('ps', ['-p', String(pid), '-o', 'command=']);
  if (!shown.ok && shown.stderr.trim() !== '') {
    return { known: false, reason: shown.stderr.trim() };
  }
  const command = shown.stdout.trim();
  return { known: true, value: command === '' ? undefined : command };
}

/**
 * What the file at the configured path is, read without becoming the thing that makes it one.
 *
 * `unpaired` is a file carrying no pairing row: either no substrate schema at all, or a store no
 * service has opened yet. `unreadable` is a file that could not be asked, which is a different
 * fact and must not be reported as an empty substrate.
 */
export type StoreObservation =
  | { readonly kind: 'paired'; readonly storeId: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unpaired' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * The substrate's own pairing id, read from the file at the configured path.
 *
 * It is minted once when a service first pairs the store and never rewritten, so it names this
 * store across every restart and does not survive the file being replaced underneath the path.
 *
 * The file is opened as it already exists: no creation, no schema, no migration, no pairing. The
 * ordinary store constructor would run the application's bootstrap, which installs fifty tables
 * into whatever it was pointed at, and a check asking which store lives here must not be the thing
 * that makes one. Write capability is kept because a read-only connection cannot attach to a live
 * WAL substrate whose shared-memory file is absent, which is the case this check exists to survive.
 */
export function observeStoreIdentity(filePath: string): StoreObservation {
  if (filePath === ':memory:' || !existsSync(filePath)) {
    return { kind: 'missing' };
  }
  let db: SqliteHandle;
  try {
    db = openExistingSqliteHandle({ filePath });
  } catch (err) {
    return { kind: 'unreadable', reason: describeError(err) };
  }
  try {
    if (!sqliteTableExists(db, 'publication_control')) {
      return { kind: 'unpaired' };
    }
    const storeId = readSubstratePairing(db)?.substrateId;
    return storeId === undefined ? { kind: 'unpaired' } : { kind: 'paired', storeId };
  } catch (err) {
    return { kind: 'unreadable', reason: describeError(err) };
  } finally {
    db.close();
  }
}

/** The id alone, for callers that only need to match one store against another. */
export function readStoreIdentity(filePath: string): string | undefined {
  const observed = observeStoreIdentity(filePath);
  return observed.kind === 'paired' ? observed.storeId : undefined;
}

/**
 * What the installation intends the service on this port to be. `buildSha` is what the job
 * carries, which is `unstamped` when the wrapper computed none; `storePath` is the configured
 * substrate, read for its identity at the moment the check runs rather than earlier, since a
 * service that has just booted is what writes the pairing row.
 */
export type IntendedService = {
  readonly port: number;
  readonly buildSha: string;
  readonly storePath: string;
};

/**
 * Who holds the port, decided before anything is written or loaded.
 *
 * `ours` is the single listener launchd names for our job, and it is the only reading that lets
 * init replace a service. Two listeners on one port are `foreign` rather than ours: membership in
 * a port-wide list proves the job is one of the processes there, not that it is the one that
 * answered.
 */
export type PortOwnership =
  | { readonly kind: 'free' }
  | { readonly kind: 'ours'; readonly pid: number }
  | { readonly kind: 'foreign'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly reason: string };

export async function readPortOwnership(
  actions: HostActions,
  port: number,
): Promise<PortOwnership> {
  const listeners = await readListenerPids(actions, port);
  if (!listeners.known) {
    return {
      kind: 'unknown',
      reason: `what is listening on port ${String(port)} could not be read: ${listeners.reason}`,
    };
  }
  const [listener, ...rest] = listeners.value;
  if (listener === undefined) {
    return { kind: 'free' };
  }
  if (rest.length > 0) {
    return {
      kind: 'foreign',
      reason: `port ${String(port)} is held by ${listeners.value.map(String).join(', ')} and the answer on it cannot be tied to any one of them`,
    };
  }
  const job = await readLaunchdJob(actions);
  if (!job.known) {
    return {
      kind: 'unknown',
      reason: `launchd could not be read for ${MCP_LAUNCH_LABEL}: ${job.reason}`,
    };
  }
  if (job.value.pid === undefined) {
    return {
      kind: 'foreign',
      reason: `launchd names no process for ${MCP_LAUNCH_LABEL} while ${String(listener)} holds port ${String(port)}`,
    };
  }
  if (job.value.pid !== listener) {
    return {
      kind: 'foreign',
      reason: `port ${String(port)} is held by ${String(listener)} and ${MCP_LAUNCH_LABEL} is pid ${String(job.value.pid)}`,
    };
  }
  return { kind: 'ours', pid: job.value.pid };
}

export type ServiceBinding =
  /** The listener is our job's process, running our build, holding the store at the path. */
  | {
      readonly kind: 'bound';
      readonly pid: number;
      readonly buildSha: string;
      readonly storeId: string;
    }
  /** Our job's process, serving something else. Replaceable: launchd owns it. */
  | { readonly kind: 'stale'; readonly reason: string }
  /** Not our job's process, or not shown to be. Reported and left alone, never replaced. */
  | { readonly kind: 'unowned'; readonly reason: string }
  /**
   * Our job's process, and nothing here can say what it is running. Reported like an unowned one,
   * because a restart cannot settle what a restart cannot change: an install carrying no build
   * identity would replace the service, read the same sentinel back, and replace it again.
   */
  | { readonly kind: 'unverified'; readonly reason: string };

function healthString(health: Record<string, unknown>, key: string): string | undefined {
  const value = health[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  return value;
}

/**
 * Decides all three at once, because any one of them alone can be true of the wrong process.
 *
 * The order is deliberate: ownership first, since a port held by something launchd did not start
 * is never ours to restart, and the build and store questions are only meaningful once the
 * answering process is known to be the job's.
 */
export async function verifyServiceBinding(
  health: Record<string, unknown>,
  intended: IntendedService,
  actions: HostActions,
): Promise<ServiceBinding> {
  const ownership = await readPortOwnership(actions, intended.port);
  if (ownership.kind === 'free') {
    return {
      kind: 'unowned',
      reason: `port ${String(intended.port)} answered /health and no listening process could be read from it`,
    };
  }
  if (ownership.kind !== 'ours') {
    return { kind: 'unowned', reason: ownership.reason };
  }

  const running = healthString(health, 'build_sha');
  const reported = running ?? UNSTAMPED_BUILD;
  if (!isRealBuildSha(intended.buildSha)) {
    return {
      kind: 'unverified',
      reason: `this install carries no build identity, and the service's ${reported} cannot be matched against one`,
    };
  }
  if (!isRealBuildSha(running)) {
    return {
      kind: 'stale',
      reason: `the service runs build ${reported} and this install carries ${intended.buildSha}`,
    };
  }
  if (running !== intended.buildSha) {
    return {
      kind: 'stale',
      reason: `the service runs build ${running} and this install carries ${intended.buildSha}`,
    };
  }

  const open = healthString(health, 'store_id');
  if (open === undefined) {
    return {
      kind: 'stale',
      reason: 'the service does not report which store it has open',
    };
  }
  const onDisk = observeStoreIdentity(intended.storePath);
  if (onDisk.kind === 'unreadable') {
    return {
      kind: 'unverified',
      reason: `the service holds store ${open} and ${intended.storePath} could not be read: ${onDisk.reason}`,
    };
  }
  if (onDisk.kind !== 'paired') {
    return {
      kind: 'stale',
      reason: `the service holds store ${open} and ${intended.storePath} carries no paired store`,
    };
  }
  if (onDisk.storeId !== open) {
    return {
      kind: 'stale',
      reason: `the service holds store ${open} and ${intended.storePath} is store ${onDisk.storeId}`,
    };
  }
  return { kind: 'bound', pid: ownership.pid, buildSha: running, storeId: open };
}
