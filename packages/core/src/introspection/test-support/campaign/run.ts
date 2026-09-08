import neo4j from 'neo4j-driver';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectBaseline, METRIC_VERSION } from './baseline.js';
import { buildCampaignManifest, type SubstrateIdentity } from './manifest.js';
import { loadConfig } from '../../../infrastructure/config/load-config.js';
import { NEO4J_DEFAULT_USER } from '../../../infrastructure/graph/provision.js';
import {
  openReadOnlySqliteHandle,
  type SqliteHandle,
} from '../../../infrastructure/sqlite/database.js';

/**
 * Takes the baseline and writes it beside the campaign's other artifacts.
 *
 * Every read is a read. The graph driver runs read queries only and the substrate file is
 * opened through the connection that cannot write, so a run against the live stores leaves
 * them exactly as it found them. The output goes to a directory the caller names, never back
 * into either store.
 *
 * Usage: node <this file> <output directory> [--sqlite <path>] [--sqlite-source copy_of_live]
 */

const USAGE =
  'usage: campaign-baseline <output directory> [--sqlite <path>] [--sqlite-source live_file|copy_of_live]';

type Args = {
  readonly outDir: string;
  readonly sqlitePath?: string;
  readonly sqliteSource: SubstrateIdentity['sqliteSource'];
};

function parseArgs(argv: readonly string[]): Args {
  const [outDir, ...rest] = argv;
  if (outDir === undefined || outDir.startsWith('-')) {
    throw new Error(USAGE);
  }
  let sqlitePath: string | undefined;
  let sqliteSource: SubstrateIdentity['sqliteSource'] = 'live_file';
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(USAGE);
    }
    if (flag === '--sqlite') {
      sqlitePath = value;
    } else if (flag === '--sqlite-source' && (value === 'live_file' || value === 'copy_of_live')) {
      sqliteSource = value;
    } else {
      throw new Error(USAGE);
    }
  }
  return { outDir, ...(sqlitePath === undefined ? {} : { sqlitePath }), sqliteSource };
}

function openSubstrate(path: string): { db?: SqliteHandle; note: string } {
  try {
    return { db: openReadOnlySqliteHandle({ filePath: path }), note: 'opened read-only' };
  } catch (err) {
    return { note: `unavailable: ${String(err)}` };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const startedAt = new Date().toISOString();

  const driver = neo4j.driver(
    config.neo4j.uri,
    neo4j.auth.basic(NEO4J_DEFAULT_USER, config.neo4j.password),
  );
  const sqlitePath = args.sqlitePath ?? config.sqlite.path;
  const substrate = openSubstrate(sqlitePath);

  try {
    await driver.verifyConnectivity();
    const baseline = await collectBaseline({
      driver,
      ...(substrate.db === undefined ? {} : { db: substrate.db }),
      sampledAt: startedAt,
    });

    const manifest = buildCampaignManifest({
      metricVersion: METRIC_VERSION,
      startedAt,
      finishedAt: new Date().toISOString(),
      buildSha: process.env.AION_BUILD_SHA ?? 'unstamped',
      config,
      substrate: {
        graphEndpoint: config.neo4j.uri,
        sqlitePath,
        sqliteSource: args.sqliteSource,
      },
      frozen: {
        staleEdgeIds: baseline.staleEdgeIds,
        graphSourceIds: baseline.graphSourceIds,
        narrativeIds: baseline.narrativeIds,
      },
    });

    mkdirSync(args.outDir, { recursive: true });
    writeFileSync(
      join(args.outDir, 'campaign-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeFileSync(
      join(args.outDir, 'campaign-baseline.json'),
      `${JSON.stringify({ substrateNote: substrate.note, ...baseline }, null, 2)}\n`,
    );
    console.log(`manifest ${manifest.manifestId}`);
    console.log(`stale edges ${String(baseline.staleEdgeIds.length)}`);
    console.log(`graph sources ${String(baseline.graphSourceIds.length)}`);
    console.log(`substrate ${substrate.note}`);
  } finally {
    substrate.db?.close();
    await driver.close();
  }
}

await main();
