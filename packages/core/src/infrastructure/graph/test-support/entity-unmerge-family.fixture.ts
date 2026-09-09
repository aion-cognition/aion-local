import type { Driver, Session } from 'neo4j-driver';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  startRehearsalSubstrate,
  stopRehearsalSubstrate,
  type RehearsalSubstrate,
} from './consolidation-rehearsal.fixture.js';
import { supersedingNodeIds } from './graph-queries.fixture.js';
import { openSqliteHandle, type SqliteHandle } from '../../sqlite/database.js';
import { writeStampedNode } from '../bitemporal.js';
import { upsertEdge } from '../edges.js';
import { redirectAndAbsorb, type MergeEntityGroupInput } from '../entity-merge-queries.js';
import { runGraphMigrations } from '../migrations.js';
import { readCanonicalMerge, type MergeProvenanceRecord } from '../unmerge-queries.js';

/**
 * One throwaway substrate carrying already-merged Entity families, for the two files that ask
 * what order `applyUnmerge` and `redirectAndAbsorb` take a family's node locks in.
 *
 * A family is built by the shipped merge writer, so the record an unmerge is driven from is the
 * one a merge actually wrote. Ids are the caller's, because which of the two sorts first is the
 * whole question: a family whose canonical sorts after its absorbed node is the arrangement the
 * unsorted pair used to invert on, and one whose canonical sorts first is the arrangement where
 * the old order happened to agree with the sort.
 *
 * No provider is constructed and no generation is requested; a run here reaches Neo4j over bolt
 * and SQLite in process and nothing else.
 */

const EMBED_DIMENSION = 8;

export type FamilyProbe = {
  readonly substrate: RehearsalSubstrate;
  readonly db: SqliteHandle;
  readonly dir: string;
  /** The driver the writers under test are handed by default. */
  readonly driver: Driver;
  /**
   * The same driver, with every failure a write transaction's body raised recorded in
   * `failures`. `inWriteTransaction` runs on `session.executeWrite`, which replays a deadlock
   * instead of reporting it, and production keeps that retry (`connection.ts`, 10s): a cycle
   * there costs repeated work and latency, and a caller's answer alone never mentions it. This
   * is where a test sees it. Setting the retry budget to zero does not do the same job, since
   * the driver checks the budget against elapsed time and always allows the first replay.
   */
  readonly watched: Driver;
  /** Every failure raised inside a `watched` write transaction, replayed away or not. */
  readonly failures: string[];
};

export type UnmergeFamily = {
  readonly canonicalId: string;
  readonly mergedId: string;
  /** The absorbed node's neighbour, so the unmerge has an edge to put back. */
  readonly neighborId: string;
  readonly record: MergeProvenanceRecord;
  /** The id a sorted pass over the pair takes first; the other one second. */
  readonly sortedFirst: string;
  readonly sortedSecond: string;
};

/** Bound to the real object, so a method that reads a private field is not handed the proxy. */
function passThrough(target: object, property: string | symbol): unknown {
  const value = Reflect.get(target, property) as unknown;
  return typeof value === 'function' ? value.bind(target) : value;
}

function watchSession(session: Session, failures: string[]): Session {
  return new Proxy(session, {
    get(target, property) {
      if (property !== 'executeWrite') {
        return passThrough(target, property);
      }
      return (work: (tx: unknown) => Promise<unknown>, config?: unknown) =>
        target.executeWrite(async (tx) => {
          try {
            return await work(tx);
          } catch (err) {
            failures.push(errorChain(err));
            throw err;
          }
        }, config as undefined);
    },
  });
}

function watchWriteFailures(driver: Driver, failures: string[]): Driver {
  return new Proxy(driver, {
    get(target, property) {
      if (property !== 'session') {
        return passThrough(target, property);
      }
      return (config?: unknown) => watchSession(target.session(config as undefined), failures);
    },
  });
}

export async function startFamilyProbe(prefix: string): Promise<FamilyProbe> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const substrate = await startRehearsalSubstrate({ sqlitePath: join(dir, 'store.sqlite') });
  const db = openSqliteHandle({ filePath: substrate.sqlitePath });
  await runGraphMigrations(substrate.harness.driver, db, { embedDimension: EMBED_DIMENSION });
  const failures: string[] = [];
  return {
    substrate,
    db,
    dir,
    driver: substrate.harness.driver,
    watched: watchWriteFailures(substrate.harness.driver, failures),
    failures,
  };
}

export async function stopFamilyProbe(probe: FamilyProbe | undefined): Promise<void> {
  probe?.db.close();
  await stopRehearsalSubstrate(probe?.substrate);
  if (probe !== undefined) {
    rmSync(probe.dir, { recursive: true, force: true });
  }
}

export async function seedEntity(driver: Driver, id: string, now: Date): Promise<void> {
  await writeStampedNode(driver, {
    label: 'Entity',
    id,
    properties: { name: id, name_norm: id, type: 'concept' },
    now,
  });
}

/** The merge input for one absorbed node, in the shape the cascade hands the writer. */
export function mergeInput(
  canonicalId: string,
  mergedId: string,
  now: Date,
): MergeEntityGroupInput {
  return {
    canonicalId,
    canonicalNameNorm: canonicalId,
    mergedIds: [mergedId],
    aliases: [mergedId],
    accessCount: 0,
    mergedRecords: [
      { id: mergedId, name: mergedId, nameNorm: mergedId, type: 'concept', aliases: [mergedId] },
    ],
    now,
  };
}

/**
 * Seeds a canonical, an absorbed node with one neighbour edge, and runs the shipped merge over
 * them, then hands back the provenance record an unmerge is driven from.
 */
export async function mergeFamily(
  probe: FamilyProbe,
  input: { readonly canonicalId: string; readonly mergedId: string; readonly now: Date },
): Promise<UnmergeFamily> {
  const { driver } = probe;
  const neighborId = `${input.mergedId}-neighbor`;
  for (const id of [input.canonicalId, input.mergedId, neighborId]) {
    await seedEntity(driver, id, input.now);
  }
  await upsertEdge(driver, {
    type: 'CO_OCCURS',
    sourceId: input.mergedId,
    targetId: neighborId,
    strength: 0.5,
    confidence: 1,
    signals: ['episodic'],
    provenance: ['test'],
    count: 1,
    now: input.now,
  });

  const merged = await redirectAndAbsorb(
    driver,
    mergeInput(input.canonicalId, input.mergedId, input.now),
  );
  if (merged.status !== 'applied') {
    throw new Error(`the family merge did not apply: ${JSON.stringify(merged)}`);
  }

  const canonical = await readCanonicalMerge(driver, input.mergedId);
  const record = canonical?.records.find((entry) => entry.mergedId === input.mergedId);
  if (record === undefined) {
    throw new Error(`no merge record names ${input.mergedId}`);
  }
  const [sortedFirst, sortedSecond] = [input.canonicalId, input.mergedId].sort();
  return {
    canonicalId: input.canonicalId,
    mergedId: input.mergedId,
    neighborId,
    record,
    sortedFirst: sortedFirst ?? input.canonicalId,
    sortedSecond: sortedSecond ?? input.mergedId,
  };
}

/**
 * The merge that overlaps an unmerge on both of its ids: a group decided off a snapshot that
 * still names the absorbed node. It takes the pair's locks and then reports `stale`, because
 * the currency check runs under those locks and the node it names is closed. That refusal is
 * the point: the two writers contend on the same two nodes before either knows the answer.
 */
export function overlappingMergeInput(family: UnmergeFamily, now: Date): MergeEntityGroupInput {
  return mergeInput(family.canonicalId, family.mergedId, now);
}

/**
 * Whether the absorbed identity is back out: the closed node carries a second replacement, the
 * restored one, beside the canonical the merge left it with. It is the whole of what an unmerge
 * writes reduced to one answer, so a writer that died mid-cycle can be asked whether it left
 * anything behind.
 */
export async function wasSplitOut(probe: FamilyProbe, family: UnmergeFamily): Promise<boolean> {
  const replacements = await supersedingNodeIds(probe.driver, family.mergedId);
  return replacements.length > 1;
}

/** The whole diagnostic chain, so a native code is never swallowed by the wrapper above it. */
export function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = err;
  for (let depth = 0; depth < 8 && cursor instanceof Error; depth += 1) {
    const { code } = cursor as { code?: unknown };
    parts.push(`${cursor.name}${typeof code === 'string' ? `[${code}]` : ''}: ${cursor.message}`);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join('\n  caused by ');
}

export function mentionsDeadlock(err: unknown): boolean {
  return /deadlock/i.test(errorChain(err));
}
