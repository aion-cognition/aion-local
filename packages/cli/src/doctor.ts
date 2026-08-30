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
  localChatModels,
  measureAdmissionFloor,
  openLogger,
  OllamaProvider,
  queueLagSnapshot,
  readVectorIndexes,
  reconcileEnrichment,
  remoteRoutes,
  resolveProviderRouting,
  scanRedactionResidue,
  SqliteStore,
  verifyGdsAvailable,
  verifyOllamaChatModel,
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

/**
 * Pure SQLite, no Neo4j: `aion doctor` printed "8 checks passed" with 4,000+ jobs pending,
 * and again with one permanently wedged job. Warn, never fail: a backlog is a thing that is
 * behind, not a thing that is broken.
 */
export function queueLagCheck(db: SqliteHandle, config: Config, now: Date = new Date()): CheckResult {
  const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts, now);
  const { interactive, bulk } = snapshot.depthByLane;
  const depth = interactive + bulk;
  const oldest = snapshot.oldestUnclaimedMs;
  const detail = [
    `depth ${String(depth)} (interactive ${String(interactive)}, bulk ${String(bulk)})`,
    `oldest unclaimed ${oldest === undefined ? 'none' : `${String(Math.round(oldest / 1000))}s`}`,
    `${String(snapshot.exhausted)} exhausted`,
    `${String(snapshot.reinforcementDropped)} reinforcement rows dropped`,
    snapshot.p95EnrichmentLagMs === undefined
      ? 'no enrichment lag samples yet'
      : `p95 enrichment lag ${String(Math.round(snapshot.p95EnrichmentLagMs / 1000))}s`,
    snapshot.cueDegradedRate === undefined
      ? 'no recalls measured yet'
      : `${(snapshot.cueDegradedRate * 100).toFixed(1)}% of recent recalls degraded on cues`,
  ].join(', ');

  const stale = oldest !== undefined && oldest > config.operational.lagOldestUnclaimedWarnMs;
  const deep = depth > config.operational.lagQueueDepthWarnThreshold;
  if (stale || deep) {
    return { ok: true, warn: true, detail };
  }
  return { ok: true, detail };
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
      /**
       * The embed model is checked under every route: it is the vector index. Chat models are
       * checked only where a role still routes to Ollama, so a key-covered install that never
       * pulled the instruct weights reads as healthy rather than as a missing model, and the
       * same install with the key removed reports the model it now needs.
       */
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

        const routing = resolveProviderRouting(config);
        const local = localChatModels(routing);
        for (const model of local) {
          await verifyOllamaChatModel(config.ollama.url, model);
        }
        const remote = remoteRoutes(routing);
        const chat =
          local.length === 0 ? 'no chat model routes locally' : `chat ${local.join(', ')} ok`;
        const routed =
          remote.length === 0
            ? ''
            : `; ${remote.map((route) => route.role).join(', ')} routed to anthropic (${remote[0]?.model ?? ''})`;
        return {
          ok: true,
          detail: `${config.models.embed} → ${vector.length} dimensions, ${chat}${routed}`,
        };
      },
    },
    {
      /**
       * Informational: it re-measures the two distributions the admission floors were
       * calibrated against and warns when this machine's model no longer separates them.
       * It never adjusts a floor. The committed constants are the runtime source of truth,
       * and a floor that drifted per machine would make two installs remember differently.
       * `floor-calibration.int.test.ts` is where a floor is re-committed.
       */
      name: 'floor-calibration',
      dependsOn: 'ollama-round-trip',
      run: async () => {
        const provider = new OllamaProvider({
          baseUrl: config.ollama.url,
          embedModel: config.models.embed,
        });
        const separation = await measureAdmissionFloor(provider, {
          vectorFloor: config.recall.vectorAdmissionFloor,
          corroborationFloor: config.recall.corroborationFloor,
          bm25Mode: config.recall.bm25AdmissionMode,
        });
        if (!separation.separated) {
          return { ok: true, warn: true, detail: separation.detail };
        }
        return { ok: true, detail: separation.detail };
      },
    },
    {
      /**
       * Informational, and the only thing that can tell a substrate nobody ever leaked into
       * from one that was. The closures stop the next write; nothing hard-deletes, so what an
       * older ruleset already stored is permanent and recall-eligible until a forget operation
       * exists to remove it. Warn rather than fail: the material is a fact about history.
       */
      name: 'redaction-residue',
      dependsOn: NEO4J_BOLT,
      run: async () => {
        const residue = await scanRedactionResidue(
          connection.driver,
          config.redaction.entropyThreshold,
        );
        const detail =
          `${String(residue.leaking)} of ${String(residue.scanned)} nodes still carry ` +
          `secret-shaped text` +
          (residue.leaking === 0
            ? ''
            : ` (${residue.ruleIds.join(', ')}; e.g. ${residue.sampleIds.join(', ')})`);
        if (residue.leaking > 0) {
          return { ok: true, warn: true, detail };
        }
        return { ok: true, detail };
      },
    },
    {
      /**
       * Propose-only supersession means every judgment is a row waiting on a person. An open
       * review queue nobody can see is the same failure from the other side: the table had
       * never held a row, and the answer to that cannot be a table nothing counts.
       * Informational, since a proposal is work to do, not a broken invariant.
       */
      name: 'review-queue',
      run: async () => {
        const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts);
        const open = snapshot.supersessionProposalsOpen + snapshot.entityMergeProposalsOpen;
        const detail =
          `${String(snapshot.supersessionProposalsOpen)} supersession, ` +
          `${String(snapshot.entityMergeProposalsOpen)} entity-merge proposals open` +
          (open === 0 ? '' : ' — aion proposals ls');
        return { ok: true, detail };
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
       * Informational: it counts episodes the substrate stored and nothing will ever enrich.
       * This is the state a queue purge, a crash between the graph write and the enqueue,
       * or an exhausted job leaves behind (no orchestrator ledger key and no queue row).
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
      name: 'queue-lag',
      run: () => Promise.resolve(queueLagCheck(db, config)),
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
