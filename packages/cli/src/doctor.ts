import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertVectorIndexDimensions,
  checkOllamaReachable,
  ConfigError,
  EmbedDimensionMismatchError,
  GraphConnection,
  latestAppliedGraphMigration,
  loadConfig,
  openLogger,
  OllamaProvider,
  readVectorIndexes,
  reconcileEnrichment,
  SqliteStore,
  verifyGdsAvailable,
  type Config,
  type SqliteHandle,
} from '@aion/core';
import { HEALTH_PATH } from '@aion/mcp';
import { mcpBaseUrl } from './compose.js';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

export type CheckResult = {
  readonly ok: boolean;
  readonly detail: string;
  /**
   * An invariant that holds against a number worth acting on. A warning is reported and
   * counted, and never changes the exit code: doctor's failures are things that are broken,
   * and a backlog is a thing that is behind.
   */
  readonly warn?: boolean;
};

export type Check = {
  readonly name: string;
  readonly dependsOn?: string;
  run(): Promise<CheckResult>;
};

export type CheckReport = CheckResult & { readonly name: string };

const NEO4J_BOLT = 'neo4j-bolt';
const GRAPH_SCHEMA = 'graph-schema';
const PROBE_FILE = '.aion-write-probe';

export type DoctorDeps = {
  readonly config: Config;
  readonly connection: GraphConnection;
  readonly db: SqliteHandle;
};

/**
 * `/health` is liveness-only (never touches Neo4j or Ollama), so a 200 here means the
 * process is up and nothing more; substrate health is the other checks' job.
 */
export async function probeMcpHttp(port: number, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  const url = `${mcpBaseUrl(port)}${HEALTH_PATH}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    return { ok: false, detail: `${String(response.status)} from ${url}` };
  }
  const body = (await response.json()) as { status?: unknown; sessions?: unknown };
  if (body.status !== 'ok') {
    return { ok: false, detail: `unexpected health payload from ${url}: ${JSON.stringify(body)}` };
  }
  return { ok: true, detail: `${url}, ${String(body.sessions)} sessions` };
}

function writableDirectories(config: Config): readonly string[] {
  return [
    ...new Set([config.operational.dataDir, dirname(config.sqlite.path), dirname(config.logging.filePath)]),
  ];
}

export function buildDoctorChecks(deps: DoctorDeps): readonly Check[] {
  const { config, connection, db } = deps;

  return [
    {
      name: NEO4J_BOLT,
      run: async () => {
        if (config.neo4j.password === '') {
          return { ok: false, detail: 'AION_NEO4J_PASSWORD is empty; run `aion init` to generate it' };
        }
        const health = await connection.health();
        if (!health.reachable) {
          return { ok: false, detail: `${connection.uri} unreachable: ${health.error ?? 'unknown error'}` };
        }
        return { ok: true, detail: `${connection.uri} (${health.agent ?? 'neo4j'})` };
      },
    },
    {
      name: 'neo4j-gds',
      dependsOn: NEO4J_BOLT,
      run: async () => {
        const version = await verifyGdsAvailable(connection.driver, connection.uri);
        return { ok: true, detail: `graph-data-science ${version}` };
      },
    },
    {
      name: 'mcp-http',
      dependsOn: NEO4J_BOLT,
      run: () => probeMcpHttp(config.operational.mcpPort),
    },
    {
      name: GRAPH_SCHEMA,
      dependsOn: NEO4J_BOLT,
      run: async () => {
        const version = latestAppliedGraphMigration(db);
        if (version === undefined) {
          return { ok: false, detail: 'no graph migration recorded; run `aion init`' };
        }
        return { ok: true, detail: `migration ${String(version).padStart(3, '0')} applied` };
      },
    },
    {
      name: 'vector-index-dimension',
      dependsOn: GRAPH_SCHEMA,
      run: async () => {
        const indexes = await readVectorIndexes(connection.driver);
        assertVectorIndexDimensions(indexes, config.models.embedDimension, config.models.embed);
        return { ok: true, detail: `${config.models.embedDimension} dimensions, cosine` };
      },
    },
    {
      name: 'ollama-round-trip',
      run: async () => {
        await checkOllamaReachable(config.ollama.url);
        const provider = new OllamaProvider({ baseUrl: config.ollama.url, embedModel: config.models.embed });
        const [vector] = await provider.embed(['aion doctor round-trip']);
        if (vector === undefined) {
          return { ok: false, detail: `${config.models.embed} returned no embedding` };
        }
        if (vector.length !== config.models.embedDimension) {
          throw new EmbedDimensionMismatchError(config.models.embed, config.models.embedDimension, vector.length);
        }
        return { ok: true, detail: `${config.models.embed} → ${vector.length} dimensions` };
      },
    },
    {
      name: 'sqlite-wal',
      run: async () => {
        const mode = db.pragma('journal_mode', { simple: true });
        if (String(mode).toLowerCase() !== 'wal') {
          return { ok: false, detail: `journal_mode is ${String(mode)}, expected wal` };
        }
        return { ok: true, detail: `${config.sqlite.path} in WAL` };
      },
    },
    {
      /**
       * Informational: it counts episodes the substrate stored and nothing will ever enrich
       * — no orchestrator ledger key and no queue row — which is the state a queue purge, a
       * crash between the graph write and the enqueue, or an exhausted job leaves behind.
       * `aion doctor` passed 8 of 8 checks with 95% of the substrate in it.
       */
      name: 'enrichment-reconcile',
      dependsOn: NEO4J_BOLT,
      run: async () => {
        const report = await reconcileEnrichment(connection.driver, db);
        const scanned = `${String(report.unenriched)} of ${String(report.episodes)} episodes unenriched and unqueued`;
        if (report.unenriched > config.operational.reconcileWarnThreshold) {
          return {
            ok: true,
            warn: true,
            detail: `${scanned}; \`aion queue reconcile --re-enqueue --yes\` queues them`,
          };
        }
        return { ok: true, detail: scanned };
      },
    },
    {
      name: 'volumes-writable',
      run: async () => {
        for (const directory of writableDirectories(config)) {
          const probe = join(directory, PROBE_FILE);
          mkdirSync(directory, { recursive: true });
          writeFileSync(probe, '');
          rmSync(probe, { force: true });
        }
        return { ok: true, detail: writableDirectories(config).join(', ') };
      },
    },
  ];
}

/**
 * A check whose dependency failed is reported rather than run: dialing Neo4j once it is
 * known unreachable buys a connection timeout per check and buries the one real cause.
 */
export async function runChecks(checks: readonly Check[], write: Writer): Promise<readonly CheckReport[]> {
  const reports: CheckReport[] = [];
  const byName = new Map<string, CheckReport>();

  for (const check of checks) {
    const dependency = check.dependsOn === undefined ? undefined : byName.get(check.dependsOn);
    let report: CheckReport;
    if (dependency !== undefined && !dependency.ok) {
      report = { name: check.name, ok: false, detail: `not checked: ${check.dependsOn} failed` };
    } else {
      try {
        report = { name: check.name, ...(await check.run()) };
      } catch (err) {
        report = { name: check.name, ok: false, detail: describeError(err) };
      }
    }
    write(`${label(report)}  ${report.name}: ${report.detail}`);
    reports.push(report);
    byName.set(report.name, report);
  }

  return reports;
}

function label(report: CheckReport): string {
  if (!report.ok) {
    return 'FAIL';
  }
  return report.warn === true ? 'warn' : 'ok  ';
}

export function summarize(reports: readonly CheckReport[], write: Writer): number {
  const failed = reports.filter((report) => !report.ok).map((report) => report.name);
  const warned = reports.filter((report) => report.ok && report.warn === true).map((report) => report.name);
  const warning = warned.length === 0 ? '' : `, ${warned.length} warning: ${warned.join(', ')}`;
  if (failed.length === 0) {
    write(`\n${reports.length} checks passed${warning}`);
    return 0;
  }
  write(`\n${failed.length} of ${reports.length} checks failed: ${failed.join(', ')}${warning}`);
  return 1;
}

export async function runDoctor(
  _argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-doctor' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  const connection = new GraphConnection(config.neo4j);
  try {
    const reports = await runChecks(buildDoctorChecks({ config, connection, db: store.db }), write);
    const code = summarize(reports, write);
    logger.info({ reports, code }, 'doctor finished');
    return code;
  } finally {
    await connection.close();
    store.close();
  }
}
