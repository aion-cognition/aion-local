import {
  countGraphElements,
  countNodesByLabel,
  describeError,
  edgeWeightDistribution,
  generationCounters,
  introspectionCycle,
  introspectionOperations,
  latestLedgerEntry,
  listLastPackSessions,
  listOllamaModels,
  listOperationStats,
  listResidentModels,
  meanOperationDurationMs,
  OPERATION_LEDGER_PREFIX,
  PACK_METHODS,
  packMethodCounters,
  packMethodLegStats,
  plasticityCounters,
  queueLagSnapshot,
  recallCadenceCounters,
  recallProbeCounters,
  remoteBannerLines,
  resolveProviderRouting,
  routingSummary,
  unbackedPins,
  type Config,
  type EdgeWeightDistribution,
  type GenerationCounters,
  type GraphConnection,
  type GraphCounts,
  type OperationStats,
  type PackMethodCounters,
  type PackMethodLegStats,
  type PlasticityCounters,
  type QueueLagSnapshot,
  type RecallCadenceCounters,
  type RecallProbeCounters,
  type SqliteHandle,
} from '@aion/core';

import { ageOf, formatEdgeWeights } from './format.js';
import { renderGeneration } from './generation-section.js';
import {
  collectMergeShadow,
  renderMergeShadow,
  type MergeShadowSnapshot,
} from './merge-shadow-section.js';
import type { Writer } from './output.js';
import { renderRecallProbe } from './recall-probe-section.js';

/**
 * `status` and `stats` read one substrate through one collector and render it through one
 * renderer, so the two commands cannot drift into two answers for the same question. `status`
 * collects and renders the base `Snapshot`; `stats` asks for `extras` too, which adds cadence,
 * the spirit metric's per-method pack shares, the maintenance ledger, and the per-label graph
 * breakdown after the same base sections `status` already printed.
 */

/**
 * One maintenance operation's record: the counters the engine keeps, plus what its most
 * recent bucket claim wrote to the ops ledger. The two come from different places on purpose.
 * The counters answer how the operation has been doing over its life; the ledger entry is the
 * evidence that one particular window ran and what it did in it.
 */
export type MaintenanceOperationReading = {
  readonly stats: OperationStats;
  readonly lastStatus?: string;
  readonly lastItemsAffected?: number;
  readonly lastDetail?: string;
};

export type MaintenanceSnapshot = {
  /** Ticks the loop has taken. Starvation is measured in these, not in wall time. */
  readonly cycle: number;
  readonly operations: readonly MaintenanceOperationReading[];
};

/** The verbose-only readings `stats` adds on top of the base view `status` also renders. */
export type SnapshotExtras = {
  /** Label to node count; a node with several labels appears under each. */
  readonly labelCounts: ReadonlyMap<string, number>;
  readonly cadence: RecallCadenceCounters;
  /** Distinct sessions a pack has ever been served to, for the calls-per-session reading. */
  readonly sessionsServed: number;
  readonly methodCounters: PackMethodCounters;
  /** Per-method sole/shared find counts and summed RRF contribution, the leg-share detail
   * behind the plain share above (see `fusion.ts`'s `MethodLegStats`). */
  readonly methodLegStats: PackMethodLegStats;
  /** Per-route call counts and failure rate: whether the model calls behind a pack answered. */
  readonly generation: GenerationCounters;
  /** What the loop found when it asked the substrate for what it was told, and what use it saw. */
  readonly recallProbe: RecallProbeCounters;
  readonly maintenance: MaintenanceSnapshot;
  readonly mergeShadow: MergeShadowSnapshot;
};

export type Snapshot = {
  readonly neo4j: { readonly uri: string; readonly reachable: boolean; readonly detail: string };
  readonly ollama: {
    readonly url: string;
    readonly reachable: boolean;
    readonly models: readonly string[];
    readonly detail?: string;
  };
  /**
   * Models Ollama is holding in memory right now, which is the number that matters on a
   * laptop: `models` above is what is on disk. Absent when Ollama did not answer.
   */
  readonly resident?: readonly string[];
  readonly graph?: GraphCounts;
  /** SQLite-only, so this is present whether or not Neo4j answered. */
  readonly queue: QueueLagSnapshot;
  /** SQLite-only, same reasoning as `queue`. */
  readonly plasticity: PlasticityCounters;
  /** The one bounded graph read, present only when Neo4j answered, like `graph` above. */
  readonly edgeWeights?: EdgeWeightDistribution;
  /** Present only when the caller asked for it; `status` leaves it unset, `stats` fills it in. */
  readonly extras?: SnapshotExtras;
};

/** The engine writes this object as the ledger summary; a hand-edited row may not match it. */
type LedgerSummary = {
  readonly status?: unknown;
  readonly itemsAffected?: unknown;
  readonly detail?: unknown;
};

function readLedgerSummary(summary: unknown): LedgerSummary {
  if (typeof summary !== 'object' || summary === null) {
    return {};
  }
  return summary;
}

/**
 * Reads the catalog rather than a stored list of names, so an operation registered in
 * `introspectionOperations` shows up here with no second place to remember to add it. One that
 * has never run reports zeroes, which is the honest reading and not an omission.
 */
export function collectMaintenance(db: SqliteHandle): MaintenanceSnapshot {
  const names = introspectionOperations().map((operation) => operation.name);
  const operations = listOperationStats(db, names).map((stats) => {
    const entry = latestLedgerEntry(db, `${OPERATION_LEDGER_PREFIX}${stats.name}:`);
    const summary = readLedgerSummary(entry?.summary);
    return {
      stats,
      ...(typeof summary.status === 'string' ? { lastStatus: summary.status } : {}),
      ...(typeof summary.itemsAffected === 'number'
        ? { lastItemsAffected: summary.itemsAffected }
        : {}),
      ...(typeof summary.detail === 'string' ? { lastDetail: summary.detail } : {}),
    };
  });
  return { cycle: introspectionCycle(db), operations };
}

export function collectSnapshot(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
  options: { readonly extras: true },
): Promise<Snapshot & { readonly extras: SnapshotExtras }>;
export function collectSnapshot(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
  options: { readonly extras: false },
): Promise<Snapshot>;
export async function collectSnapshot(
  config: Config,
  connection: GraphConnection,
  db: SqliteHandle,
  options: { readonly extras: boolean },
): Promise<Snapshot> {
  const health = await connection.health();
  const graph = health.reachable ? await countGraphElements(connection.driver) : undefined;
  const edgeWeights = health.reachable
    ? await edgeWeightDistribution(connection.driver)
    : undefined;

  let models: readonly string[] = [];
  let resident: readonly string[] | undefined;
  let ollamaError: string | undefined;
  try {
    models = await listOllamaModels(config.ollama.url);
    resident = (await listResidentModels(config.ollama.url)).map((model) => model.name);
  } catch (err) {
    ollamaError = describeError(err);
  }

  const base: Snapshot = {
    neo4j: {
      uri: connection.uri,
      reachable: health.reachable,
      detail: health.reachable ? (health.agent ?? 'neo4j') : (health.error ?? 'unreachable'),
    },
    ollama: {
      url: config.ollama.url,
      reachable: ollamaError === undefined,
      models,
      ...(ollamaError === undefined ? {} : { detail: ollamaError }),
    },
    ...(resident === undefined ? {} : { resident }),
    ...(graph === undefined ? {} : { graph }),
    queue: queueLagSnapshot(db, config.operational.workerMaxAttempts),
    plasticity: plasticityCounters(db),
    ...(edgeWeights === undefined ? {} : { edgeWeights }),
  };

  if (!options.extras) {
    return base;
  }

  const labelCounts = health.reachable
    ? await countNodesByLabel(connection.driver)
    : new Map<string, number>();
  const mergeShadow = await collectMergeShadow(
    db,
    connection,
    health.reachable,
    config.maintenance.autoMerge,
  );

  return {
    ...base,
    extras: {
      labelCounts,
      cadence: recallCadenceCounters(db),
      sessionsServed: listLastPackSessions(db).length,
      methodCounters: packMethodCounters(db),
      methodLegStats: packMethodLegStats(db),
      generation: generationCounters(db),
      recallProbe: recallProbeCounters(db),
      maintenance: collectMaintenance(db),
      mergeShadow,
    },
  };
}

function totalMethodCount(counters: PackMethodCounters): number {
  return PACK_METHODS.reduce((sum, method) => sum + counters[method], 0);
}

const OPERATION_NAME_WIDTH = 24;

/**
 * One line per registered operation. An operation with no runs says so rather than printing a
 * row of zeroes that reads like a measurement, since "never selected" and "selected and did
 * nothing" are different answers to the only question this section exists for.
 */
function renderMaintenance(snapshot: MaintenanceSnapshot, now: number, write: Writer): void {
  write('');
  write('maintenance');
  write(
    `  cycle ${String(snapshot.cycle)}, ${String(snapshot.operations.length)} operations registered`,
  );
  for (const reading of snapshot.operations) {
    const { stats } = reading;
    const name = stats.name.padEnd(OPERATION_NAME_WIDTH);
    if (stats.lastRunAt === undefined) {
      write(`  ${name} never selected`);
      continue;
    }
    const age = ageOf(Math.max(0, now - Date.parse(stats.lastRunAt)));
    const affected =
      reading.lastItemsAffected === undefined
        ? ''
        : ` (${String(reading.lastItemsAffected)} affected)`;
    const mean = meanOperationDurationMs(stats);
    const cost = mean === undefined ? '' : `  ~${(mean / 1000).toFixed(1)}s/run`;
    write(
      `  ${name} runs ${String(stats.runs)}  improved ${String(stats.improved)}  ` +
        `unchanged ${String(stats.unchanged)}  failed ${String(stats.failed)}  ` +
        `unmeasured ${String(stats.unmeasured)}${cost}  ` +
        `last ${age} ago ${reading.lastStatus ?? 'unrecorded'}${affected}`,
    );
  }
}

/** The longest lane name, so every `MODE:` in the section starts at one column. */
const LANE_NAME_WIDTH = 19;

/**
 * The lanes that act on their own between two ticks of a person looking, with the two-word
 * verdict `aion status` gives every one of them: `acting` or `off`, never a third state a
 * knob's own vocabulary might suggest. `merge_auto`, `proposal_resolution` and
 * `proposal_hygiene` read their one dedicated boolean. The two proposal lanes get a line each
 * because one off does not stop the other: resolution decides an open row on its merits, and
 * hygiene ages out whatever resolution keeps failing on.
 * Supersession has no boolean of its own: `propose` queues everything and
 * closes nothing, so `unanimous` and the legacy `auto` are what "acting" means for it, and the
 * mode name is shown alongside for the same reason `queue` shows a lane's own depth rather
 * than just a total. The cascade's judge tier reads the same way under
 * `AION_ENTITY_MERGE_MODE`, and it is a separate line from `merge_auto` because the two are
 * separate switches: `merge_auto` governs the deterministic tier, which merges whatever the
 * judge tier is doing. Tier 3 only acts when its kill switch is on and its own mode knob says
 * `act`; `propose` records a recommendation and runs nothing, which reads as `off` here for
 * the same reason it reads as `off` in `docs/operations.md`. `keyed_close` is an eighth
 * switch, independent of `supersedeMode`: it runs inside a different stage's write and reads
 * the same way supersession does, `off` or the mode it routes into.
 */
function laneMode(acting: boolean): 'acting' | 'off' {
  return acting ? 'acting' : 'off';
}

function renderLanes(config: Config, write: Writer): void {
  write('');
  write('lanes');
  write(
    `  ${'merge_auto'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.autoMerge)}`,
  );

  const { entityMergeMode } = config.reflection;
  const entityMergeActing = entityMergeMode !== 'propose';
  const entityMergeDetail = entityMergeActing ? ` (${entityMergeMode})` : '';
  write(
    `  ${'entity_dedup'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(entityMergeActing)}${entityMergeDetail}`,
  );

  const supersessionMode = config.reflection.supersedeMode;
  const supersessionActing = supersessionMode !== 'propose';
  const supersessionDetail = supersessionActing ? ` (${supersessionMode})` : '';
  write(
    `  ${'supersession'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(supersessionActing)}${supersessionDetail}`,
  );

  const { keyedCloseMode } = config.reflection;
  const keyedCloseActing = keyedCloseMode !== 'off';
  const keyedCloseDetail = keyedCloseActing ? ` (${keyedCloseMode})` : '';
  write(
    `  ${'keyed_close'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(keyedCloseActing)}${keyedCloseDetail}`,
  );

  write(
    `  ${'proposal_resolution'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.proposalResolution)}`,
  );

  write(
    `  ${'proposal_hygiene'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.proposalHygiene)}`,
  );

  write(
    `  ${'claim_dedup'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(config.maintenance.claimDedup)}`,
  );

  const tier3Acting = config.maintenance.tier3 && config.maintenance.tier3Mode === 'act';
  write(`  ${'tier3'.padEnd(LANE_NAME_WIDTH)} MODE: ${laneMode(tier3Acting)}`);
}

/** Skipped while Neo4j is down: the base `graph` line above already reported that. */
function renderLabelCounts(
  reachable: boolean,
  labelCounts: ReadonlyMap<string, number>,
  write: Writer,
): void {
  if (!reachable) {
    return;
  }
  write('');
  write('substrate');
  if (labelCounts.size === 0) {
    write('  empty');
    return;
  }
  for (const [label, count] of labelCounts) {
    write(`  ${label.padEnd(14)} ${String(count)}`);
  }
}

export function renderSnapshot(
  snapshot: Snapshot,
  config: Config,
  write: Writer,
  now: number = Date.now(),
): void {
  write(
    `neo4j    ${snapshot.neo4j.reachable ? 'up' : 'down'}  ${snapshot.neo4j.uri} (${snapshot.neo4j.detail})`,
  );
  write(
    `ollama   ${snapshot.ollama.reachable ? 'up' : 'down'}  ${snapshot.ollama.url}${snapshot.ollama.detail === undefined ? '' : ` (${snapshot.ollama.detail})`}`,
  );

  write('');
  const routing = resolveProviderRouting(config);
  write(
    `models   embed=${config.models.embed} cue=${config.models.cue} reflect=${config.models.reflect}`,
  );
  write(`routing  ${routingSummary(routing)} (embeddings always ${config.models.embed}, local)`);
  for (const route of unbackedPins(routing)) {
    write(
      `         ${route.role} is pinned to anthropic with no key set, so it runs on ${route.localModel}`,
    );
  }
  if (snapshot.ollama.models.length > 0) {
    write(`installed  ${snapshot.ollama.models.join(', ')}`);
  }
  if (snapshot.resident !== undefined) {
    write(
      `resident   ${snapshot.resident.length === 0 ? 'nothing loaded in memory' : snapshot.resident.join(', ')}`,
    );
  }
  for (const line of remoteBannerLines(routing)) {
    write(line);
  }

  write('');
  if (snapshot.graph === undefined) {
    write('graph    counts unavailable while Neo4j is down');
  } else {
    write(`graph    ${snapshot.graph.nodes} nodes, ${snapshot.graph.relationships} relationships`);
  }

  write('');
  const { queue } = snapshot;
  const oldest =
    queue.oldestUnclaimedMs === undefined ? 'none unclaimed' : ageOf(queue.oldestUnclaimedMs);
  const p95 =
    queue.p95EnrichmentLagMs === undefined ? 'no samples yet' : ageOf(queue.p95EnrichmentLagMs);
  const depth = `interactive=${String(queue.depthByLane.interactive)} bulk=${String(queue.depthByLane.bulk)}`;
  const degraded =
    queue.cueDegradedRate === undefined
      ? 'no recalls yet'
      : `${(queue.cueDegradedRate * 100).toFixed(1)}% of recent recalls degraded on cues`;
  write(`queue    ${depth}, oldest unclaimed ${oldest}, ${String(queue.exhausted)} exhausted`);
  write(
    `lag      p95 intake-to-enriched ${p95}, ${String(queue.reinforcementDropped)} reinforcement rows dropped`,
  );
  write(`recall   ${degraded}`);
  write(
    `review   ${String(queue.supersessionProposalsOpen)} supersession, ` +
      `${String(queue.entityMergeProposalsOpen)} entity-merge proposals open... aion proposals ls`,
  );

  renderLanes(config, write);

  write('');
  const { plasticity } = snapshot;
  write(
    `hebbian  reinforce ${String(plasticity.reinforcement.signalsApplied)} signals / ` +
      `${String(plasticity.reinforcement.pairsApplied)} pairs / ${String(plasticity.reinforcement.edgesUpdated)} edges ` +
      `(last run ${plasticity.reinforcement.lastRunAt ?? 'never run'}), queue depth ${String(plasticity.reinforcementQueueDepth)}`,
  );
  write(
    `decay    ${String(plasticity.decay.edgesScanned)} scanned / ${String(plasticity.decay.edgesDecayed)} decayed ` +
      `(last run ${plasticity.decay.lastRunAt ?? 'never run'})`,
  );
  if (snapshot.edgeWeights === undefined) {
    write('weights  unavailable while Neo4j is down');
  } else {
    write(`weights  ${formatEdgeWeights(snapshot.edgeWeights)}`);
  }

  const { extras } = snapshot;
  if (extras === undefined) {
    return;
  }

  renderLabelCounts(snapshot.neo4j.reachable, extras.labelCounts, write);

  write('');
  write('cadence');
  const perSession =
    extras.sessionsServed === 0 ? undefined : extras.cadence.totalCalls / extras.sessionsServed;
  write(
    `  calls        ${String(extras.cadence.totalCalls)} across ${String(extras.sessionsServed)} sessions${
      perSession === undefined ? '' : ` (${perSession.toFixed(1)} per session)`
    }`,
  );
  const emptyRate =
    extras.cadence.totalCalls === 0
      ? undefined
      : extras.cadence.emptyPacks / extras.cadence.totalCalls;
  write(
    `  empty packs  ${String(extras.cadence.emptyPacks)}${
      emptyRate === undefined ? '' : ` (${(emptyRate * 100).toFixed(1)}%)`
    }`,
  );

  write('');
  write('pack contribution by method (the spirit metric)');
  const total = totalMethodCount(extras.methodCounters);
  for (const method of PACK_METHODS) {
    const count = extras.methodCounters[method];
    const share = total === 0 ? 0 : (count / total) * 100;
    const legStat = extras.methodLegStats[method];
    write(
      `  ${method.padEnd(18)} ${String(count).padStart(6)}  ${share.toFixed(1)}%` +
        `  sole ${String(legStat.sole)}  shared ${String(legStat.shared)}` +
        `  rrf ${legStat.rrfContribution.toFixed(3)}`,
    );
  }

  renderGeneration(extras.generation, write);
  renderRecallProbe(extras.recallProbe, write);
  renderMaintenance(extras.maintenance, now, write);
  renderMergeShadow(extras.mergeShadow, write);
}
