import {
  bootstrapBackbone,
  countExperiencesByVersion,
  countUsageEvents,
  DEFAULT_SQLITE_PATH,
  experienceArchiveSpan,
  isManagedNeo4jUri,
  latestAppliedGraphMigration,
  PIPELINE_VERSION,
  ProviderRouter,
  readMemberName,
  recordLifecycleEvent,
  ReflectionOrchestrator,
  replayExperiences,
  replayUsageEvents,
  SessionManager,
  type Config,
  type ReplayDeps,
  type ReplayProgress,
  type ReplayReport,
  type ReplaySelection,
  type UsageReplayProgress,
  type UsageReplayReport,
} from '@aion/core';
import { reflectionStages } from '@aion/mcp';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { lifecycleIntakeDeps } from './lifecycle.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate, type Substrate } from './substrate.js';

/**
 * `aion replay`: the experience archive put back through the pipeline. Reflection reads the
 * archive rather than a live transport, so a prompt or extraction change is re-derived from
 * what the substrate was actually told instead of migrated in place.
 *
 * `usage` is the second half of the same rebuild. `run` restores what the substrate knows;
 * `usage` restores what it found worth knowing, by re-applying the access, reinforcement and
 * decay events the usage stream recorded. On a graph rebuilt from the archive the two run in
 * that order, since the salience events name nodes and edges the pipeline has to write first.
 *
 * A replay under a new pipeline version re-enters every stage, and two of the writes those
 * stages make count real observations rather than converging on one value: the MENTIONS
 * salience bump and the co-occurrence edge count. `last_accessed` also feeds identifier decay,
 * so a replay clock there moves a maintenance decision that has nothing to do with the data.
 * That is why the target is a scratch substrate by default and the shipped one takes
 * `--live --yes`.
 */

const SUBCOMMANDS = ['ls', 'run', 'usage'] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

const SPEC: ArgSpec<Subcommand> = {
  command: 'replay',
  usage:
    'aion replay [ls | run | usage] [--all] [--stale] [--episode <id>] [--session <id>] ' +
    '[--limit <n>] [--batch <n>] [--live] [--yes] [--json]',
  subcommands: SUBCOMMANDS,
  options: [
    { flag: '--all' },
    { flag: '--stale' },
    { flag: '--episode', takesValue: true },
    { flag: '--session', takesValue: true },
    { flag: '--limit', takesValue: true },
    { flag: '--batch', takesValue: true },
    { flag: '--live' },
    { flag: '--yes' },
    { flag: '--json' },
  ],
};

export type ReplayFlags = {
  readonly subcommand: Subcommand;
  /** False selects only rows archived under some other pipeline version. */
  readonly all: boolean;
  /** The default selection, named: `--stale` is `!all` spelled out, never its own field elsewhere. */
  readonly stale: boolean;
  readonly episode?: string;
  readonly session?: string;
  readonly limit?: number;
  readonly batch?: number;
  readonly live: boolean;
  readonly yes: boolean;
  readonly json: boolean;
};

/** Zero or a fraction reads as a typo, and either would silently replay nothing. */
function countOf(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliUsageError(`${flag} got '${value}', expected a positive integer`);
  }
  return parsed;
}

export function parseReplayFlags(argv: readonly string[]): ReplayFlags {
  const { subcommand, flags, values } = parseArgs(SPEC, argv);
  if (flags.has('--all') && flags.has('--stale')) {
    throw new CliUsageError('--all and --stale select different rows; pass one of them');
  }
  const episode = values.get('--episode');
  const session = values.get('--session');
  const limit = countOf('--limit', values.get('--limit'));
  const batch = countOf('--batch', values.get('--batch'));

  const all = flags.has('--all');
  return {
    subcommand,
    all,
    stale: !all,
    live: flags.has('--live'),
    yes: flags.has('--yes'),
    json: flags.has('--json'),
    ...(episode === undefined ? {} : { episode }),
    ...(session === undefined ? {} : { session }),
    ...(limit === undefined ? {} : { limit }),
    ...(batch === undefined ? {} : { batch }),
  };
}

function selectionOf(flags: ReplayFlags): ReplaySelection {
  return {
    stale: flags.stale,
    ...(flags.episode === undefined ? {} : { episodeId: flags.episode }),
    ...(flags.session === undefined ? {} : { sessionId: flags.session }),
  };
}

export function describeSubstrate(config: Config): string {
  return `sqlite=${config.sqlite.path} neo4j=${config.neo4j.uri}`;
}

/**
 * The scratch gate. Both halves of the substrate have to be somewhere other than where the
 * shipped defaults point before a replay may write, since a replay that re-enters stages
 * inflates the two counters that record real observations. `--live --yes` is the deliberate
 * way past it, and the refusal names what it was about to write to.
 */
export function defaultSubstrateRefusal(config: Config, flags: ReplayFlags): string | undefined {
  if (flags.live && flags.yes) {
    return undefined;
  }
  const shipped: string[] = [];
  if (config.sqlite.path === DEFAULT_SQLITE_PATH) {
    shipped.push('AION_SQLITE_PATH');
  }
  if (isManagedNeo4jUri(config.neo4j.uri)) {
    shipped.push('AION_NEO4J_URI');
  }
  if (shipped.length === 0) {
    return undefined;
  }
  return (
    `replay would write to the shipped substrate (${describeSubstrate(config)}): ` +
    `${shipped.join(' and ')} still point at the default. Point them at a scratch ` +
    'substrate, or pass --live --yes to replay onto this one'
  );
}

function renderLs(substrate: Substrate, flags: ReplayFlags): number {
  const db = substrate.db();
  const byVersion = countExperiencesByVersion(db);
  const span = experienceArchiveSpan(db);
  const total = byVersion.reduce((sum, entry) => sum + entry.count, 0);
  const stale = byVersion
    .filter((entry) => entry.version !== PIPELINE_VERSION)
    .reduce((sum, entry) => sum + entry.count, 0);

  // Both streams, because a rebuild reads both: the archive says what a `run` would re-derive
  // and the usage count says what a `usage` pass would put back on top of it.
  const usage = countUsageEvents(db);

  if (flags.json) {
    substrate.write(
      JSON.stringify({
        pipeline_version: PIPELINE_VERSION,
        total,
        stale,
        by_version: byVersion.map((entry) => ({ version: entry.version, count: entry.count })),
        oldest_occurred_at: span?.oldestOccurredAt ?? null,
        newest_occurred_at: span?.newestOccurredAt ?? null,
        usage_events: usage,
      }),
    );
    return 0;
  }

  substrate.write(`pipeline   ${PIPELINE_VERSION}`);
  substrate.write(`archived   ${String(total)} experiences, ${String(stale)} stale`);
  for (const entry of byVersion) {
    substrate.write(`  ${entry.version.padEnd(10)} ${String(entry.count)}`);
  }
  if (span !== undefined) {
    substrate.write(`occurred   ${span.oldestOccurredAt} to ${span.newestOccurredAt}`);
  }
  substrate.write(`usage      ${String(usage)} events`);
  return 0;
}

function renderProgress(progress: ReplayProgress, write: Writer): void {
  write(
    `replayed ${String(progress.replayed)}, skipped ${String(progress.skipped)}, ` +
      `at ${progress.cursor.occurredAt}`,
  );
}

function renderReport(report: ReplayReport, write: Writer): void {
  write(`scanned     ${String(report.scanned)}`);
  write(`replayed    ${String(report.replayed)}`);
  write(`skipped     ${String(report.skipped)}`);
  write(`unavailable ${String(report.unavailable)}`);
  write(`failed      ${String(report.failed)}`);
  if (report.aborted) {
    write(
      report.cursor === undefined
        ? 'aborted before the first batch; nothing was replayed'
        : `aborted at ${report.cursor.occurredAt} / ${report.cursor.id}`,
    );
  }
}

function toJson(report: ReplayReport): unknown {
  return {
    pipeline_version: PIPELINE_VERSION,
    scanned: report.scanned,
    replayed: report.replayed,
    skipped: report.skipped,
    unavailable: report.unavailable,
    failed: report.failed,
    aborted: report.aborted,
    cursor:
      report.cursor === undefined
        ? null
        : { occurred_at: report.cursor.occurredAt, id: report.cursor.id },
  };
}

function renderUsageProgress(progress: UsageReplayProgress, write: Writer): void {
  write(
    `applied ${String(progress.scanned - progress.skipped - progress.failed)} of ` +
      `${String(progress.scanned)}, at ${progress.cursor.occurredAt}`,
  );
}

function renderUsageReport(report: UsageReplayReport, write: Writer): void {
  write(`scanned       ${String(report.scanned)}`);
  write(`access        ${String(report.accessApplied)}`);
  write(
    `reinforcement ${String(report.reinforcementApplied)}, ` +
      `${String(report.edgesReinforced)} edges`,
  );
  write(`decay         ${String(report.decayApplied)}, ${String(report.edgesDecayed)} edges`);
  write(`skipped       ${String(report.skipped)}`);
  write(`failed        ${String(report.failed)}`);
  if (report.aborted) {
    write(
      report.cursor === undefined
        ? 'aborted before the first batch; nothing was applied'
        : `aborted at ${report.cursor.occurredAt} / ${String(report.cursor.id)}`,
    );
  }
}

function toUsageJson(report: UsageReplayReport): unknown {
  return {
    scanned: report.scanned,
    access_applied: report.accessApplied,
    reinforcement_applied: report.reinforcementApplied,
    edges_reinforced: report.edgesReinforced,
    decay_applied: report.decayApplied,
    edges_decayed: report.edgesDecayed,
    skipped: report.skipped,
    failed: report.failed,
    aborted: report.aborted,
    cursor:
      report.cursor === undefined
        ? null
        : { occurred_at: report.cursor.occurredAt, id: report.cursor.id },
  };
}

/**
 * Abort on the first interrupt, and let a second one kill the process outright: the first
 * stops the loop between batches so the cursor is reported, and an operator who asks twice is
 * telling us the graceful stop is taking too long.
 */
export function abortOnInterrupt(): AbortController {
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  return controller;
}

/**
 * The two gates both writing paths pass: the scratch refusal, and a substrate that has been
 * through `aion init` at all. Every message names what it was about to write to.
 */
function writeRefusal(substrate: Substrate, flags: ReplayFlags): string | undefined {
  const refusal = defaultSubstrateRefusal(substrate.config, flags);
  if (refusal !== undefined) {
    return refusal;
  }
  if (latestAppliedGraphMigration(substrate.db()) === undefined) {
    return (
      `no schema on this substrate (${describeSubstrate(substrate.config)}); ` +
      'run `aion init` against it first'
    );
  }
  return undefined;
}

/**
 * The usage stream re-applied over a rebuilt graph. It takes the same scratch gate `run` does,
 * and for a sharper reason: every event it applies is an additive write, so a pass over a graph
 * that already carries its own stamps counts each access twice.
 */
async function runUsageReplay(substrate: Substrate, flags: ReplayFlags): Promise<number> {
  const { config, write } = substrate;
  const refusal = writeRefusal(substrate, flags);
  if (refusal !== undefined) {
    stderrWriter(refusal);
    return 1;
  }

  const connection = await substrate.requireGraph('replay usage');
  if (connection === undefined) {
    return 1;
  }

  const controller = abortOnInterrupt();
  const report = await replayUsageEvents(
    { driver: connection.driver, db: substrate.db(), logger: substrate.logger() },
    {
      batchSize: flags.batch ?? config.maintenance.replayBatchSize,
      signal: controller.signal,
      ...(flags.limit === undefined ? {} : { limit: flags.limit }),
      // A JSON caller gets one document, so per-batch lines would corrupt it.
      ...(flags.json
        ? {}
        : {
            onBatch: (progress: UsageReplayProgress) => {
              renderUsageProgress(progress, write);
            },
          }),
    },
  );

  if (flags.json) {
    write(JSON.stringify(toUsageJson(report)));
  } else {
    renderUsageReport(report, write);
  }
  return report.failed > 0 ? 1 : 0;
}

async function runReplay(substrate: Substrate, flags: ReplayFlags): Promise<number> {
  const { config, write } = substrate;
  const refusal = writeRefusal(substrate, flags);
  if (refusal !== undefined) {
    stderrWriter(refusal);
    return 1;
  }

  const db = substrate.db();
  const connection = await substrate.requireGraph('replay');
  if (connection === undefined) {
    return 1;
  }
  const { driver } = connection;
  const logger = substrate.logger();
  const memberName = await readMemberName(driver);
  if (memberName === undefined) {
    stderrWriter(
      `no backbone on this substrate (${describeSubstrate(config)}); ` +
        'run `aion init` against it first',
    );
    return 1;
  }

  const backbone = await bootstrapBackbone(driver, { memberName });
  const provider = new ProviderRouter({ config }).forRole('reflect');
  const deps: ReplayDeps = {
    driver,
    db,
    sessions: new SessionManager(driver, {
      memberId: backbone.member.id,
      workspaceId: backbone.workspace.id,
    }),
    runner: new ReflectionOrchestrator({ driver, db, provider, logger }, reflectionStages(config)),
    logger,
  };

  const controller = abortOnInterrupt();
  const report = await replayExperiences(deps, {
    selection: selectionOf(flags),
    batchSize: flags.batch ?? config.maintenance.replayBatchSize,
    // The operator's own moment. It stamps transaction time and the locks; world time stays
    // the archived experience's, so nothing here dates a write back to when the thing happened.
    clock: () => new Date(),
    signal: controller.signal,
    ...(flags.limit === undefined ? {} : { limit: flags.limit }),
    // A JSON caller gets one document, so per-batch lines would corrupt it.
    ...(flags.json
      ? {}
      : {
          onBatch: (progress: ReplayProgress) => {
            renderProgress(progress, write);
          },
        }),
  });

  // A pass that re-derived nothing changed nothing about the substrate, and a run that skipped
  // every row is the ordinary no-op. Only a pass that actually replayed is worth remembering.
  if (report.replayed > 0) {
    await recordLifecycleEvent(
      lifecycleIntakeDeps({
        connection,
        db,
        config,
        logger,
        memberId: backbone.member.id,
        workspaceId: backbone.workspace.id,
      }),
      {
        event: 'replay_completed',
        text:
          `replay completed: ${String(report.replayed)} of ${String(report.scanned)} experiences ` +
          `replayed, ${String(report.skipped)} skipped, ${String(report.failed)} failed, ` +
          `pipeline ${PIPELINE_VERSION}`,
      },
    );
  }

  if (flags.json) {
    write(JSON.stringify(toJson(report)));
  } else {
    renderReport(report, write);
  }
  return report.failed > 0 ? 1 : 0;
}

export function runReplayCommand(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseReplayFlags,
    run: async (substrate, flags) => {
      if (flags.subcommand === 'run') {
        return await runReplay(substrate, flags);
      }
      if (flags.subcommand === 'usage') {
        return await runUsageReplay(substrate, flags);
      }
      return renderLs(substrate, flags);
    },
  });
}
