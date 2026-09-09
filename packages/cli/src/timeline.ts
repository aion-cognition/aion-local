import {
  buildEpisodeTimeline,
  checkCoverage,
  fetchNodeEdges,
  fetchNodeProvenance,
  findPendingReflectionJob,
  getExperienceByEpisode,
  getExperienceById,
  getLedgerEntry,
  INTEGRATE_JOB_TYPE,
  listSessionEpisodeIds,
  loadEpisodeContext,
  orchestratorLedgerKey,
  listReferenceBatches,
  listSourcePublications,
  PIPELINE_VERSION,
  readSourceRecord,
  refusalLines,
  stageLedgerKey,
  type ExperienceArchiveRow,
  type SqliteHandle,
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
/**
 * The archive row this occurrence's own records point at.
 *
 * An occurrence is not its archive row. A source pushed again after a forget is a new
 * occurrence over bytes an earlier one already stored, so looking the archive up by episode id
 * finds nothing for it and reports a source the substrate is holding as absent. C1's canonical
 * mapping is what says which row belongs to this occurrence; the episode lookup stays as the
 * answer for a legacy capture that has no identity record yet.
 */
function canonicalArchiveRow(
  db: SqliteHandle,
  episodeId: string,
): ExperienceArchiveRow | undefined {
  const record = readSourceRecord(db, episodeId);
  const canonical = record?.canonicalArchiveId;
  return canonical === null || canonical === undefined
    ? getExperienceByEpisode(db, episodeId)
    : getExperienceById(db, canonical);
}

async function hydrateTimeline(
  substrate: Substrate,
  episodeId: string,
): Promise<readonly TimelineEvent[] | undefined> {
  const db = substrate.db();
  const { driver } = substrate.connection();

  const archive = canonicalArchiveRow(db, episodeId);
  const [episodeContext, provenance, edges] = await Promise.all([
    loadEpisodeContext(driver, episodeId),
    fetchNodeProvenance(driver, episodeId),
    fetchNodeEdges(driver, episodeId),
  ]);

  // A source the records know is a source this command answers for, whether or not the graph
  // still projects it and whether or not it owns an archive row of its own.
  const record = readSourceRecord(db, episodeId);
  const known = record !== undefined;
  if (archive === undefined && episodeContext === undefined && provenance === undefined && !known) {
    return undefined;
  }

  const pipelineVersion = archive?.pipelineVersion ?? PIPELINE_VERSION;
  const queueJob = findPendingReflectionJob(db, INTEGRATE_JOB_TYPE, EPISODE_ID_FIELD, episodeId);
  const stages = reflectionStages(substrate.config).map((stage) => ({
    name: stage.name,
    entry: getLedgerEntry(db, stageLedgerKey(pipelineVersion, stage.name, episodeId)),
  }));
  const runEntry = getLedgerEntry(db, orchestratorLedgerKey(pipelineVersion, episodeId));

  const derivedEdges = edges.edges.filter(
    (edge) => edge.type === 'EXTRACTED_FROM' && !edge.outgoing,
  );
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

  // The occurrence's own records, beside the bytes it may share with an earlier push. Without
  // them the shared archive row's clocks would be read as this occurrence's, which is how a
  // repush prints its predecessor's capture time.
  const occurrence =
    record === undefined
      ? undefined
      : {
          occurredAt: new Date(record.occurredAt),
          acceptedAt: new Date(record.createdAt),
          sharedArchive:
            archive !== undefined && record.canonicalArchiveId !== null
              ? archive.episodeId !== episodeId
              : false,
          verificationStatus: record.verificationStatus,
        };
  const references = listReferenceBatches(db, episodeId).map((batch) => ({
    version: batch.referenceVersion,
    receivedAt: new Date(batch.receivedAt),
    acceptedHash: batch.acceptedHash,
  }));
  // The publication half of the same history. `sequence` stays the string the store hands over;
  // it is minted as a SQLite integer that can be larger than a double holds exactly.
  const publications = listSourcePublications(db, episodeId).map((receipt) => ({
    sequence: receipt.sequence,
    operationId: receipt.operationId,
    kind: receipt.kind,
    state: receipt.state,
    ...(receipt.knownFrom === null ? {} : { knownFrom: receipt.knownFrom }),
    ...(receipt.observedAckAt === null ? {} : { observedAckAt: receipt.observedAckAt }),
    clockClamped: receipt.clockClamped,
    createdAt: receipt.createdAt,
  }));

  return buildEpisodeTimeline({
    episodeId,
    archive,
    ...(occurrence === undefined ? {} : { occurrence }),
    references,
    publications,
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
    if (event.note !== undefined) {
      write(`    ${event.note}`);
    }
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
      // The coverage decision comes before any read, as it does on every covered entry point.
      // A substrate whose control record cannot be read is one whose answers are all suspect,
      // and a timeline assembled anyway would be a claim about history nobody can stand behind.
      const checked = checkCoverage(substrate.db(), { now: new Date(), expiryAnnotation: true });
      if (checked.status === 'refused') {
        for (const line of refusalLines(checked.refusal)) {
          stderrWriter(line);
        }
        return 1;
      }
      if (flags.target === 'session') {
        return await runSession(substrate, flags.sessionId, flags.json);
      }
      return await runOneEpisode(substrate, flags.episodeId, flags.json);
    },
  });
}
