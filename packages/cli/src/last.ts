import {
  ConfigError,
  getLastPack,
  listLastPackSessions,
  loadConfig,
  openLogger,
  PACK_BUCKETS,
  SqliteStore,
  type Config,
  type LastPackSession,
  type PackBucket,
} from '@aion/core';
import { MemoryPackSchema, type Cue, type MemoryPack, type MemoryPackItem, type StageTimingsMs } from '@aion/protocol';
import { describeError, stderrWriter, stdoutWriter, type Writer } from './output.js';

/** Render exactly the pack a session was served, not a recomputed view. */

export class UnknownOptionError extends Error {
  constructor(option: string) {
    super(`unknown option '${option}' for last (supported: --session, --json)`);
    this.name = 'UnknownOptionError';
  }
}

export class MissingOptionValueError extends Error {
  constructor(option: string) {
    super(`--${option} needs a value`);
    this.name = 'MissingOptionValueError';
  }
}

export type LastFlags = {
  readonly session?: string;
  readonly json: boolean;
};

export function parseLastFlags(argv: readonly string[]): LastFlags {
  let session: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--session') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new MissingOptionValueError('session');
      }
      session = value;
      index += 1;
      continue;
    }
    throw new UnknownOptionError(arg ?? '');
  }

  return { json, ...(session === undefined ? {} : { session }) };
}

const BUCKET_LABELS: Readonly<Record<PackBucket, string>> = {
  facts: 'Facts',
  episodes: 'Episodes',
  narratives: 'Narratives',
  preferences: 'Preferences',
  resonant: 'Resonant',
};

const STAGES: readonly (keyof StageTimingsMs)[] = [
  'cues',
  'embed',
  'seeds',
  'activation',
  'fusion',
  'resonance',
];

/**
 * One item's rationale line: rank, method, the two scores, and whichever of
 * path/currency/lineage/occurred-at apply. `confidence` is the absolute measurement admission
 * read and is comparable between items; `score` is the producing method's own number and is
 * not, which is why the rank is printed beside them.
 */
function itemFacts(item: MemoryPackItem): string {
  const facts = [
    `id=${item.id}`,
    `rank=${String(item.rank)}`,
    `method=${item.rationale.method}`,
    `confidence=${item.confidence.toFixed(3)}`,
    `score=${item.rationale.score.toFixed(3)}`,
  ];
  if (item.rationale.path !== undefined) {
    facts.push(`path=${item.rationale.path}`);
  }
  facts.push(`currency=${item.currency}`);
  if (item.superseded_by !== undefined) {
    facts.push(`superseded_by=${item.superseded_by.id}@${item.superseded_by.at}`);
  }
  if (item.occurred_at !== undefined) {
    facts.push(`occurred=${item.occurred_at}`);
  }
  return facts.join(' ');
}

function renderCue(cue: Cue): string {
  return `  ${cue.text}  (${cue.source} x${String(cue.weight)})`;
}

export type LastPackEntry = {
  readonly sessionId: string;
  readonly ts: string;
  readonly pack: MemoryPack;
};

/** Render the full per-item, per-stage view of what recall served and why. */
export function renderPack(entry: LastPackEntry, write: Writer): void {
  write(`session  ${entry.sessionId}`);
  write(`served   ${entry.ts}`);
  for (const rung of entry.pack.metadata.degraded ?? []) {
    write(`degraded  ${rung.stage}: ${rung.reason}`);
  }
  write('');

  let renderedAnyBucket = false;
  for (const bucket of PACK_BUCKETS) {
    const items = entry.pack[bucket];
    if (items === undefined || items.length === 0) {
      continue;
    }
    renderedAnyBucket = true;
    write(`## ${BUCKET_LABELS[bucket]}`);
    items.forEach((item, index) => {
      write(`${String(index + 1)}. ${item.content}`);
      write(`   ${itemFacts(item)}`);
    });
    write('');
  }
  if (!renderedAnyBucket) {
    write('(empty pack)');
    write('');
  }

  write('cues');
  if (entry.pack.metadata.cues.length === 0) {
    write('  none');
  } else {
    for (const cue of entry.pack.metadata.cues) {
      write(renderCue(cue));
    }
  }
  write('');

  write('stage timings (ms)');
  for (const stage of STAGES) {
    // A stage with no reading was not in the pipeline when this pack was stored, which is a
    // different thing from a stage that ran in no time, so the line says so rather than
    // printing a zero the reader would take for a measurement.
    const ms = entry.pack.metadata.stage_timings_ms[stage];
    write(`  ${stage.padEnd(10)} ${ms === undefined ? '-' : ms.toFixed(2)}`);
  }
  write('');

  write(`token estimate  ${String(entry.pack.metadata.token_estimate)}`);
}

export function renderSessionList(
  sessions: readonly LastPackSession[],
  selectedId: string,
  write: Writer,
): void {
  write(`sessions with packs (${String(sessions.length)})`);
  for (const session of sessions) {
    const marker = session.sessionId === selectedId ? '*' : ' ';
    write(`  ${marker} ${session.sessionId}  ${session.ts}`);
  }
  write('');
}

export async function runLast(argv: readonly string[] = [], write: Writer = stdoutWriter): Promise<number> {
  let flags: LastFlags;
  let config: Config;
  try {
    flags = parseLastFlags(argv);
    config = loadConfig(process.env);
  } catch (err) {
    stderrWriter(err instanceof ConfigError ? err.message : describeError(err));
    return 1;
  }

  const logger = openLogger({ ...config.logging, name: 'aion-last' });
  const store = new SqliteStore({ filePath: config.sqlite.path });
  try {
    const sessions = listLastPackSessions(store.db);
    const targetId = flags.session ?? sessions[0]?.sessionId;
    if (targetId === undefined) {
      stderrWriter(
        flags.session === undefined
          ? 'no memory packs recorded yet'
          : `no pack recorded for session '${flags.session}'`,
      );
      return 1;
    }

    const row = getLastPack(store.db, targetId);
    if (row === undefined) {
      stderrWriter(`no pack recorded for session '${targetId}'`);
      return 1;
    }

    if (flags.json) {
      write(row.packJson);
      logger.info({ sessionId: targetId }, 'last pack rendered as json');
      return 0;
    }

    const pack = MemoryPackSchema.parse(row.pack);
    if (flags.session === undefined) {
      renderSessionList(sessions, targetId, write);
    }
    renderPack({ sessionId: targetId, ts: row.ts, pack }, write);
    logger.info({ sessionId: targetId }, 'last pack rendered');
    return 0;
  } catch (err) {
    logger.error({ err: describeError(err) }, 'last failed');
    stderrWriter(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return 1;
  } finally {
    store.close();
  }
}
