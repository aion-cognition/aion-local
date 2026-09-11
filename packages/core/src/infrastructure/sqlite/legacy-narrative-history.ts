import { IsoTimestampSchema } from '@aion/protocol';
import { z } from 'zod';

import type { SqliteHandle } from './database.js';
import { readLegacyNarrative, type LegacyNarrativeRecord } from './legacy-narratives.js';

const OriginalPublication = z.strictObject({
  knownFrom: IsoTimestampSchema,
  basis: z.literal('graph_tx_from'),
  recordedBy: z.string().min(1),
});

function parseOriginal(json: string | null): z.infer<typeof OriginalPublication> | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    const result = OriginalPublication.safeParse(JSON.parse(json));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** Inventory copies a recorded legacy clock, never its own acknowledgment time. The first valid proof survives later inventories. */
export function acknowledgeLegacyOriginalClock(
  db: SqliteHandle,
  narrativeId: string,
  original: string | null,
  operationId: string,
): void {
  if (!db.inTransaction) {
    throw new Error('legacy history requires its inventory acknowledgment transaction');
  }
  const parsed = IsoTimestampSchema.safeParse(original);
  if (!parsed.success) {
    return;
  }
  const held = readLegacyNarrative(db, narrativeId);
  if (held === undefined) {
    throw new Error('legacy history has no inventoried identity');
  }
  if (parseOriginal(held.originalPublicationJson) !== undefined) {
    return;
  }
  db.prepare(
    'UPDATE legacy_narratives SET original_publication_json = ? WHERE narrative_id = ?',
  ).run(
    JSON.stringify({
      knownFrom: new Date(parsed.data).toISOString(),
      basis: 'graph_tx_from',
      recordedBy: operationId,
    }),
    narrativeId,
  );
}

/** A copied clock is usable only after its producing inventory was acknowledged. */
export function readLegacyOriginalClock(
  db: SqliteHandle,
  record: LegacyNarrativeRecord,
): string | undefined {
  const original = parseOriginal(record.originalPublicationJson);
  if (original === undefined) {
    return undefined;
  }
  const acknowledged = db
    .prepare(
      "SELECT 1 FROM publication_intents WHERE operation_id = ? AND kind = 'family_cutover' AND state = 'acknowledged'",
    )
    .get(original.recordedBy);
  return acknowledged === undefined ? undefined : new Date(original.knownFrom).toISOString();
}
