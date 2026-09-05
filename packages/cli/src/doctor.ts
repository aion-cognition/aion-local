import {
  assertVectorIndexDimensions,
  checkOllamaReachable,
  describeError,
  EmbedDimensionMismatchError,
  embedQueryPrefix,
  latestAppliedGraphMigration,
  localChatModels,
  measureAdmissionFloor,
  OllamaProvider,
  queueLagSnapshot,
  readVectorIndexes,
  reconcileEnrichment,
  remoteRoutes,
  resolveProviderRouting,
  scanRedactionResidue,
  verifyGdsAvailable,
  verifyOllamaChatModel,
  type Config,
  type GraphConnection,
  type SqliteHandle,
} from '@aion/core';
import { HEALTH_PATH } from '@aion/mcp';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseArgs, type ArgSpec } from './args.js';
import { mcpBaseUrl } from './compose.js';
import { hooksKeyedOnlyCheck, queueLagCheck, readingHorizonCheck } from './doctor-checks.js';
import { stdoutWriter, type Writer } from './output.js';
import { withSubstrate } from './substrate.js';

const SPEC: ArgSpec = {
  command: 'doctor',
  usage: 'aion doctor',
};

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
  /** Where the host facts `bin/aion` computes are read from. Injected so tests supply their own. */
  readonly env?: NodeJS.ProcessEnv;
};

/** Everything the two probes read off `/health`, typed once at the one place it is decoded. */
type HealthPayload = {
  readonly status?: unknown;
  readonly sessions?: unknown;
  readonly build_sha?: unknown;
};

type HealthRead =
  | { readonly url: string; readonly body: HealthPayload }
  | { readonly url: string; readonly failure: CheckResult };

async function readHealth(port: number, fetchImpl: typeof fetch): Promise<HealthRead> {
  const url = `${mcpBaseUrl(port)}${HEALTH_PATH}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    return { url, failure: { ok: false, detail: `${String(response.status)} from ${url}` } };
  }
  return { url, body: (await response.json()) as HealthPayload };
}

/**
 * `/health` is liveness-only (never touches Neo4j or Ollama), so a 200 here means the
 * process is up and nothing more; substrate health is the other checks' job.
 */
export async function probeMcpHttp(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckResult> {
  const read = await readHealth(port, fetchImpl);
  if ('failure' in read) {
    return read.failure;
  }
  const { url, body } = read;
  if (body.status !== 'ok') {
    return { ok: false, detail: `unexpected health payload from ${url}: ${JSON.stringify(body)}` };
  }
  return { ok: true, detail: `${url}, ${String(body.sessions)} sessions` };
}

/**
 * The running service can trail the repo: a rebuilt image only reaches the container on the
 * next recreate, and nothing else surfaces the lag. Warns rather than fails, because an
 * intentionally pinned older service is a choice, not a fault.
 */
export async function probeServiceFreshness(
  port: number,
  repoHeadSha: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckResult> {
  const read = await readHealth(port, fetchImpl);
  if ('failure' in read) {
    return read.failure;
  }
  const running = typeof read.body.build_sha === 'string' ? read.body.build_sha : 'unstamped';
  if (running === 'unstamped') {
    return {
      ok: true,
      warn: true,
      detail: 'service image carries no build sha; rebuild through bin/aion to stamp it',
    };
  }
  if (repoHeadSha === undefined || repoHeadSha.length === 0) {
    return { ok: true, warn: true, detail: `service at ${running}; repo HEAD unknown here` };
  }
  if (running === repoHeadSha) {
    return { ok: true, detail: `service and repo both at ${running}` };
  }
  return {
    ok: true,
    warn: true,
    detail: `service runs ${running} but the repo is at ${repoHeadSha}; rebuild and recreate aion-mcp`,
  };
}

function writableDirectories(config: Config): readonly string[] {
  return [
    ...new Set([
      config.operational.dataDir,
      dirname(config.sqlite.path),
      dirname(config.logging.filePath),
    ]),
  ];
}

export function buildDoctorChecks(deps: DoctorDeps): readonly Check[] {
  const { config, connection, db, env = process.env } = deps;

  return [
    {
      name: NEO4J_BOLT,
      run: async () => {
        if (config.neo4j.password === '') {
          return {
            ok: false,
            detail: 'AION_NEO4J_PASSWORD is empty; run `aion init` to generate it',
          };
        }
        const health = await connection.health();
        if (!health.reachable) {
          return {
            ok: false,
            detail: `${connection.uri} unreachable: ${health.error ?? 'unknown error'}`,
          };
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
      name: 'service-freshness',
      dependsOn: 'mcp-http',
      run: () => probeServiceFreshness(config.operational.mcpPort, process.env.AION_REPO_HEAD_SHA),
    },
    {
      name: GRAPH_SCHEMA,
      dependsOn: NEO4J_BOLT,
      run: () => {
        const version = latestAppliedGraphMigration(db);
        if (version === undefined) {
          return Promise.resolve({
            ok: false,
            detail: 'no graph migration recorded; run `aion init`',
          });
        }
        return Promise.resolve({
          ok: true,
          detail: `migration ${String(version).padStart(3, '0')} applied`,
        });
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
        const provider = new OllamaProvider({
          baseUrl: config.ollama.url,
          embedModel: config.models.embed,
        });
        const [vector] = await provider.embed(['aion doctor round-trip']);
        if (vector === undefined) {
          return { ok: false, detail: `${config.models.embed} returned no embedding` };
        }
        if (vector.length !== config.models.embedDimension) {
          throw new EmbedDimensionMismatchError(
            config.models.embed,
            config.models.embedDimension,
            vector.length,
          );
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
        const separation = await measureAdmissionFloor(
          provider,
          {
            vectorFloor: config.recall.vectorAdmissionFloor,
            corroborationFloor: config.recall.corroborationFloor,
            bm25Mode: config.recall.bm25AdmissionMode,
          },
          embedQueryPrefix(config.models.embed),
        );
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
          `secret-shaped text${
            residue.leaking === 0
              ? ''
              : ` (${residue.ruleIds.join(', ')}; e.g. ${residue.sampleIds.join(', ')})`
          }`;
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
      run: () => {
        const snapshot = queueLagSnapshot(db, config.operational.workerMaxAttempts);
        const open = snapshot.supersessionProposalsOpen + snapshot.entityMergeProposalsOpen;
        const detail =
          `${String(snapshot.supersessionProposalsOpen)} supersession, ` +
          `${String(snapshot.entityMergeProposalsOpen)} entity-merge proposals open${
            open === 0 ? '' : '... aion proposals ls'
          }`;
        return Promise.resolve({ ok: true, detail });
      },
    },
    {
      name: 'sqlite-wal',
      run: () => {
        const mode = db.pragma('journal_mode', { simple: true });
        if (String(mode).toLowerCase() !== 'wal') {
          return Promise.resolve({
            ok: false,
            detail: `journal_mode is ${String(mode)}, expected wal`,
          });
        }
        return Promise.resolve({ ok: true, detail: `${config.sqlite.path} in WAL` });
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
      name: 'reading-horizon',
      dependsOn: NEO4J_BOLT,
      run: () => readingHorizonCheck(connection.driver),
    },
    {
      name: 'queue-lag',
      run: () => Promise.resolve(queueLagCheck(db, config)),
    },
    {
      name: 'hooks-keyed-only',
      run: () => Promise.resolve(hooksKeyedOnlyCheck(config, env)),
    },
    {
      name: 'volumes-writable',
      run: () => {
        for (const directory of writableDirectories(config)) {
          const probe = join(directory, PROBE_FILE);
          mkdirSync(directory, { recursive: true });
          writeFileSync(probe, '');
          rmSync(probe, { force: true });
        }
        return Promise.resolve({ ok: true, detail: writableDirectories(config).join(', ') });
      },
    },
  ];
}

/**
 * A check whose dependency failed is reported rather than run: dialing Neo4j once it is
 * known unreachable buys a connection timeout per check and buries the one real cause.
 */
export async function runChecks(
  checks: readonly Check[],
  write: Writer,
): Promise<readonly CheckReport[]> {
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
  const warned = reports
    .filter((report) => report.ok && report.warn === true)
    .map((report) => report.name);
  const warning = warned.length === 0 ? '' : `, ${warned.length} warning: ${warned.join(', ')}`;
  if (failed.length === 0) {
    write(`\n${reports.length} checks passed${warning}`);
    return 0;
  }
  write(`\n${failed.length} of ${reports.length} checks failed: ${failed.join(', ')}${warning}`);
  return 1;
}

export function runDoctor(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: (args) => parseArgs(SPEC, args),
    run: async (substrate) => {
      const deps: DoctorDeps = {
        config: substrate.config,
        connection: substrate.connection(),
        db: substrate.db(),
      };
      const reports = await runChecks(buildDoctorChecks(deps), write);
      const code = summarize(reports, write);
      substrate.logger().info({ reports, code }, 'doctor finished');
      return code;
    },
  });
}
