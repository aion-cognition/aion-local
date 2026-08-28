import { randomUUID } from 'node:crypto';
import type { SqliteHandle } from './database.js';

export type ReinforcementSignal = {
  id: string;
  sourceId: string;
  targetId: string;
  trigger: string;
  ts: string;
};

type ReinforcementSignalRow = {
  id: string;
  source_id: string;
  target_id: string;
  trigger: string;
  ts: string;
};

function toReinforcementSignal(row: ReinforcementSignalRow): ReinforcementSignal {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    trigger: row.trigger,
    ts: row.ts,
  };
}

/** Enqueue only; flushing into Hebbian reinforcement is deferred past P2 (whitepaper §7). */
export function enqueueReinforcementSignal(
  db: SqliteHandle,
  sourceId: string,
  targetId: string,
  trigger: string,
  ts: string = new Date().toISOString(),
): string {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO reinforcement_queue (id, source_id, target_id, trigger, ts) VALUES (?, ?, ?, ?, ?)',
  ).run(id, sourceId, targetId, trigger, ts);
  return id;
}

/** Ordered by insertion (rowid), not ts: same-millisecond bursts would tie on the latter. */
export function listReinforcementSignals(db: SqliteHandle): ReinforcementSignal[] {
  const rows = db
    .prepare('SELECT * FROM reinforcement_queue ORDER BY rowid ASC')
    .all() as ReinforcementSignalRow[];
  return rows.map(toReinforcementSignal);
}
