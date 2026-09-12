import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What this install put on the machine, written by init and read by uninstall.
 *
 * Uninstall has to answer a question nothing else can: of the things it finds, which ones did we
 * put there. A Neo4j somebody already ran, a plugin jar they placed by hand, a config file they
 * maintain — removing any of those because it happens to match what we would have written is the
 * kind of help nobody asks for twice. So init stamps what it actually did, and anything not in the
 * stamp is reported as present and not provably ours, with the command to remove it by hand.
 *
 * It lives in the data root because that is the one directory this install owns outright, and
 * because uninstall's last act is to remove that directory: the record goes with the thing it
 * describes rather than outliving it somewhere else.
 */

export const INSTALL_MANIFEST_NAME = 'install-manifest.json';

export const INSTALL_MANIFEST_VERSION = 1;

export type InstallManifest = {
  readonly version: number;
  readonly profile: string;
  readonly recordedAt: string;
  readonly repoDir: string;
  readonly dataDir: string;
  /** The launchd job this install wrote, absent where it wrote none. */
  readonly launchdPlist?: string;
  readonly neo4jHome?: string;
  readonly neo4jConfFile?: string;
  /** The settings keys this build owns in that file. Values are matched before a line is cut. */
  readonly neo4jSettings?: readonly (readonly [string, string])[];
  /** The plugin jar this install downloaded. Absent when one was already in place. */
  readonly gdsJar?: string;
};

export function manifestPath(dataDir: string): string {
  return join(dataDir, INSTALL_MANIFEST_NAME);
}

export function writeInstallManifest(dataDir: string, manifest: InstallManifest): string {
  const path = manifestPath(dataDir);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

/**
 * The stamp, or nothing. A missing or unreadable manifest is the ordinary case for an install
 * that predates it or one somebody assembled by hand, and it reads as "we can prove nothing"
 * rather than as an error: uninstall still removes what it can name for itself.
 */
export function readInstallManifest(dataDir: string): InstallManifest | undefined {
  const path = manifestPath(dataDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as InstallManifest;
    return parsed.version === INSTALL_MANIFEST_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}
