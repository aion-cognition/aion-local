import {
  buildEpisodeTimeline,
  fetchNodeEdges,
  fetchNodeProvenance,
  findPendingReflectionJob,
  getExperienceByEpisode,
  getLedgerEntry,
  INTEGRATE_JOB_TYPE,
  listSessionEpisodeIds,
  loadEpisodeContext,
  orchestratorLedgerKey,
  PIPELINE_VERSION,
  stageLedgerKey,
  type TimelineEvent,
} from '@aion/core';
import { reflectionStages } from '@aion/mcp';

import { CliUsageError, parseArgs, type ArgSpec } from './args.js';
import { stderrWriter, stdoutWriter, type Writer } from './output.js';
import { withSubstrate, type Substrate } from './substrate.js';

/**
 * `aion timeline <episode_id>`: one episode's life on the substrate as ordered events, each
 * tagged with the clock it came off. Distinct from `aion why`, which answers a node's own
 * provenance and lineage; this answers what happened to the episode itself across the archive,
 * the graph, the queue, and the ledger.
 *
 * `--session <id>` renders every episode the session holds in place of one id, oldest first.
 */

const EPISODE_ID_FIELD = 'episode_id';

const SPEC: ArgSpec = {
  command: 'timeline',
  usage: 'aion timeline <episode_id> | --session <session_id> [--json]',
  options: [{ flag: '--session', takesValue: true }, { flag: '--json' }],
  maxPositionals: 1,
};

export type TimelineFlags =
  | { readonly target: 'episode'; readonly episodeId: string; readonly json: boolean }
  | { readonly target: 'session'; readonly sessionId: string; readonly json: boolean };

export function parseTimelineFlags(argv: readonly string[]): TimelineFlags {
  const { positionals, values, flags } = parseArgs(SPEC, argv);
  const [episodeId] = positionals;
  const sessionId = values.get('--session');
  const json = flags.has('--json');

  if (episodeId !== undefined && sessionId !== undefined) {
    throw new CliUsageError('pass an episode id or --session, not both');
  }
  if (sessionId !== undefined) {
    return { target: 'session', sessionId, json };
  }
  if (episodeId !== undefined) {
    return { target: 'episode', episodeId, json };
  }
  throw new CliUsageError(
    'timeline needs an episode id or --session <id>: `aion timeline <episode_id>`',
  );
}

/**
 * The seven-source hydration. Ledger keys point-read rather than prefix-scan (the episode id
 * is the key's suffix, not a namespace `listLedgerEntries` could scan), so this depends on the
 * pipeline's own stage list; the version they gate on is the one the episode was archived
 * under, so an episode enriched before a pipeline bump keeps reading as enriched. Returns
 * undefined only when every source came back empty, which is what an unknown id looks like.
 */
async function hydrateTimeline(
  substrate: Substrate,
  episodeId: string,
): Promise<readonly TimelineEvent[] | undefined> {
  const db = substrate.db();
  const { driver } = substrate.connection();

  const archive = getExperienceByEpisode(db, episodeId);
  const [episodeContext, provenance, edges] = await Promise.all([
    loadEpisodeContext(driver, episodeId),
    fetchNodeProvenance(driver, episodeId),
    fetchNodeEdges(driver, episodeId),
  ]);

  if (archive === undefined && episodeContext === undefined && provenance === undefined) {
    return undefined;
  }

  const pipelineVersion = archive?.pipelineVersion ?? PIPELINE_VERSION;
  const queueJob = findPendingReflectionJob(db, INTEGRATE_JOB_TYPE, EPISODE_ID_FIELD, episodeId);
  const stages = reflectionStages(substrate.config).map((stage) => ({
    name: stage.name,
    entry: getLedgerEntry(db, stageLedgerKey(pipelineVersion, stage.name, episodeId)),
  }));
  const runEntry = getLedgerEntry(db, orchestratorLedgerKey(pipelineVersion, episodeId));

  const derivedEdges = edges.filter((edge) => edge.type === 'EXTRACTED_FROM' && !edge.outgoing);
  const derivedNodes = await Promise.all(
    derivedEdges.map(async (edge) => {
      const nodeProvenance = await fetchNodeProvenance(driver, edge.otherId);
      return {
        id: edge.otherId,
        labels: edge.otherLabels,
        occurredAt: nodeProvenance?.occurredAt,
        txFrom: nodeProvenance?.txFrom,
      };
    }),
  );

  return buildEpisodeTimeline({
    episodeId,
    archive,
    episodeOccurredAt: episodeContext?.occurredAt,
    episodeValidFrom: provenance?.validFrom,
    episodeTxFrom: provenance?.txFrom,
    queueJob,
    stages,
    runEntry,
    derivedNodes,
  });
}

export function renderTimeline(
  episodeId: string,
  events: readonly TimelineEvent[],
  write: Writer,
): void {
  write(`episode  ${episodeId}`);
  if (events.length === 0) {
    write('  nothing found: no archive row, no graph node, no queue row');
    return;
  }
  for (const event of events) {
    write(`  ${event.at.toISOString()}  ${event.clock.padEnd(5)}  ${event.summary}`);
  }
}

export function toJson(episodeId: string, events: readonly TimelineEvent[]): unknown {
  return {
    episode_id: episodeId,
    events: events.map((event) => ({
      kind: event.kind,
      at: event.at.toISOString(),
      clock: event.clock,
      summary: event.summary,
      detail: event.detail,
    })),
  };
}

async function runOneEpisode(
  substrate: Substrate,
  episodeId: string,
  json: boolean,
): Promise<number> {
  const events = await hydrateTimeline(substrate, episodeId);
  if (events === undefined) {
    stderrWriter(`no episode found for '${episodeId}'`);
    return 1;
  }
  if (json) {
    substrate.write(JSON.stringify(toJson(episodeId, events)));
  } else {
    renderTimeline(episodeId, events, substrate.write);
  }
  return 0;
}

async function runSession(substrate: Substrate, sessionId: string, json: boolean): Promise<number> {
  const { driver } = substrate.connection();
  const episodeIds = await listSessionEpisodeIds(driver, sessionId);
  if (episodeIds.length === 0) {
    stderrWriter(`no episodes found for session '${sessionId}'`);
    return 1;
  }

  if (json) {
    const documents: unknown[] = [];
    for (const episodeId of episodeIds) {
      documents.push(toJson(episodeId, (await hydrateTimeline(substrate, episodeId)) ?? []));
    }
    substrate.write(JSON.stringify(documents));
    return 0;
  }
  for (const episodeId of episodeIds) {
    renderTimeline(episodeId, (await hydrateTimeline(substrate, episodeId)) ?? [], substrate.write);
    substrate.write('');
  }
  return 0;
}

export function runTimelineCommand(
  argv: readonly string[] = [],
  write: Writer = stdoutWriter,
): Promise<number> {
  return withSubstrate({
    spec: SPEC,
    argv,
    write,
    parse: parseTimelineFlags,
    needsGraph: 'timeline',
    run: async (substrate, flags) => {
      if (flags.target === 'session') {
        return await runSession(substrate, flags.sessionId, flags.json);
      }
      return await runOneEpisode(substrate, flags.episodeId, flags.json);
    },
  });
}
