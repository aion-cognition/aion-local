import neo4j from 'neo4j-driver';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectBaseline, METRIC_VERSION } from './baseline.js';
import { buildCampaignManifest, type BuildProvenance, type SqliteAcquisition } from './manifest.js';
import { loadConfig } from '../../../infrastructure/config/load-config.js';
import { NEO4J_DEFAULT_USER } from '../../../infrastructure/graph/provision.js';
import {
  openReadOnlySqliteHandle,
  sqliteTableExists,
  type SqliteHandle,
} from '../../../infrastructure/sqlite/database.js';
import { ARCHIVE_SCHEMA_VERSION } from '../../../infrastructure/sqlite/experience-archive.js';

/**
 * Takes the baseline and writes it beside the campaign's other artifacts.
 *
 * Every read is a read. The graph driver runs read queries only and the substrate file is
 * opened through the connection that cannot write, so a run against the live stores leaves
 * them exactly as it found them. The output goes to a directory the caller names, never back
 * into either store.
 *
 * Each run writes under its own identity and refuses to overwrite a file that is already
 * there. A manifest is a record of what one run froze, and a second invocation writing over it
 * would leave two runs claiming one immutable record.
 *
 * Usage: node <this file> <output directory> [--sqlite <path>] [--sqlite-source <how>]
 *        [--sqlite-acquired-from <iso>] [--sqlite-acquired-until <iso>]
 */

const USAGE = [
  'usage: campaign-baseline <output directory>',
  '  [--sqlite <path>] [--sqlite-source live_file|copy_of_live|backup_api]',
  '  [--sqlite-acquired-from <iso>] [--sqlite-acquired-until <iso>]',
].join('\n');

const ACQUISITIONS: readonly string[] = ['live_file', 'copy_of_live', 'backup_api'];

type Args = {
  readonly outDir: string;
  readonly sqlitePath?: string;
  readonly sqliteSource: SqliteAcquisition;
  readonly acquiredFrom?: string;
  readonly acquiredUntil?: string;
};

function parseArgs(argv: readonly string[]): Args {
  const [outDir, ...rest] = argv;
  if (outDir === undefined || outDir.startsWith('-')) {
    throw new Error(USAGE);
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error(USAGE);
    }
    flags.set(flag, value);
  }
  const source = flags.get('--sqlite-source') ?? 'live_file';
  if (!ACQUISITIONS.includes(source)) {
    throw new Error(USAGE);
  }
  const sqlitePath = flags.get('--sqlite');
  const acquiredFrom = flags.get('--sqlite-acquired-from');
  const acquiredUntil = flags.get('--sqlite-acquired-until');
  return {
    outDir,
    sqliteSource: source as SqliteAcquisition,
    ...(sqlitePath === undefined ? {} : { sqlitePath }),
    ...(acquiredFrom === undefined ? {} : { acquiredFrom }),
    ...(acquiredUntil === undefined ? {} : { acquiredUntil }),
  };
}

/** Refuses rather than replaces: an output already there belongs to a run that already ran. */
function writeOnce(path: string, value: unknown): void {
  if (existsSync(path)) {
    throw new Error(`${path} already exists; each run writes under its own identity`);
  }
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fileDigest(path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

function openSubstrate(path: string): { db?: SqliteHandle; note: string } {
  try {
    return { db: openReadOnlySqliteHandle({ filePath: path }), note: 'opened read-only' };
  } catch (err) {
    return { note: `unavailable: ${String(err)}` };
  }
}

/** What the substrate had installed, as far as this side can see it. */
function provenanceOf(db: SqliteHandle | undefined): BuildProvenance {
  const tables =
    db === undefined
      ? []
      : (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
            name: string;
          }[]
        ).map((row) => row.name);
  const migrations =
    db === undefined || !sqliteTableExists(db, 'meta')
      ? []
      : (
          db
            .prepare("SELECT key FROM meta WHERE key LIKE 'graph:migration:%' ORDER BY key")
            .all() as { key: string }[]
        ).map((row) => row.key);
  return {
    collectorBuildSha: process.env.AION_BUILD_SHA ?? 'unknown',
    // Not readable from here: the running service stamps its own image, and this process is
    // not that image.
    deployedBuildSha: 'unknown',
    collectorArchiveSchemaVersion: ARCHIVE_SCHEMA_VERSION,
    installedSqliteTables: tables,
    appliedGraphMigrations: migrations,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, '-')}-${createHash('sha256')
    .update(`${startedAt}${String(process.pid)}`)
    .digest('hex')
    .slice(0, 8)}`;

  const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(NEO4J_DEFAULT_USER, config.neo4j.password),
  );
  const sqlitePath = args.sqlitePath ?? config.sqlite.path;
  const substrate = openSubstrate(sqlitePath);
  mkdirSync(args.outDir, { recursive: true });

  try {
    await driver.verifyConnectivity();
    const baseline = await collectBaseline({
      driver,
      ...(substrate.db === undefined ? {} : { db: substrate.db }),
      sampledAt: startedAt,
      exportDir: join(args.outDir, `cohort-export-${runId}`),
    });
    writeOnce(join(args.outDir, `campaign-baseline-${runId}.json`), {
      substrateNote: substrate.note,
      ...baseline,
    });

    const { staleEdgeIds, graphSourceIds, narrativeIds } = baseline;
    if (staleEdgeIds === undefined || graphSourceIds === undefined || narrativeIds === undefined) {
      // A manifest records what was frozen. Writing one over a walk that did not finish would
      // freeze a membership nobody read.
      throw new Error(`cohort walk incomplete: ${JSON.stringify(baseline.failures)}`);
    }

    const digest = fileDigest(sqlitePath);
    const manifest = buildCampaignManifest({
      metricVersion: METRIC_VERSION,
      startedAt,
      finishedAt: new Date().toISOString(),
      buildSha: process.env.AION_BUILD_SHA ?? 'unstamped',
      provenance: provenanceOf(substrate.db),
      config,
      substrate: {
        graphEndpoint: config.neo4j.uri,
        sqlitePath,
        sqliteSource: args.sqliteSource,
        ...(args.acquiredFrom === undefined ? {} : { sqliteAcquiredFrom: args.acquiredFrom }),
        ...(args.acquiredUntil === undefined ? {} : { sqliteAcquiredUntil: args.acquiredUntil }),
        ...(digest === undefined ? {} : { sqliteDigest: digest }),
      },
      frozen: { staleEdgeIds, graphSourceIds, narrativeIds },
    });

    writeOnce(join(args.outDir, `campaign-manifest-${runId}.json`), manifest);
    console.log(`run ${runId}`);
    console.log(`manifest ${manifest.manifestId}`);
    console.log(`stale edges ${String(staleEdgeIds.length)}`);
    console.log(`graph sources ${String(graphSourceIds.length)}`);
    console.log(`narratives ${String(narrativeIds.length)}`);
    console.log(`export complete ${String(baseline.exportComplete)}`);
    console.log(`substrate ${substrate.note}, ${String(statSync(sqlitePath).size)} bytes`);
  } finally {
    substrate.db?.close();
    await driver.close();
  }
}

await main();
