import type { Driver } from 'neo4j-driver';
import neo4j from 'neo4j-driver';

import type { GraphTransaction } from './connection.js';
import { PUBLICATION_GUARD_LABEL } from './publication-guard.js';
import { PublicationInvariantError } from '../publication/errors.js';
import { decimalSequence } from '../publication/json.js';

export type GuardReceipt = {
  readonly substrateId: string;
  readonly protocolVersion: number;
  readonly operationId: string | null;
  readonly sequence: string;
  readonly intentDigest: string | null;
  readonly resultDigest: string | null;
};

const RETURN_RECEIPT = `RETURN g.substrate_id AS substrateId, g.protocol_version AS protocolVersion,
  g.operation_id AS operationId, coalesce(toString(g.sequence), '0') AS sequence,
  g.payload_digest AS intentDigest, g.result_digest AS resultDigest`;

function receipt(row: Record<string, unknown> | undefined): GuardReceipt {
  if (
    row === undefined ||
    typeof row.substrateId !== 'string' ||
    typeof row.protocolVersion !== 'number' ||
    typeof row.sequence !== 'string'
  ) {
    throw new PublicationInvariantError('publication_guard_missing_or_invalid');
  }
  for (const field of ['operationId', 'intentDigest', 'resultDigest']) {
    if (row[field] !== null && typeof row[field] !== 'string') {
      throw new PublicationInvariantError('publication_receipt_invalid');
    }
  }
  decimalSequence(row.sequence);
  return {
    substrateId: row.substrateId,
    protocolVersion: row.protocolVersion,
    sequence: row.sequence,
    operationId: row.operationId as string | null,
    intentDigest: row.intentDigest as string | null,
    resultDigest: row.resultDigest as string | null,
  };
}

/** The administrative lock is held by this explicit transaction until commit or rollback. */
export async function lockPublicationGuard(
  tx: GraphTransaction,
  substrateId: string,
  now: Date,
): Promise<GuardReceipt> {
  const rows = await tx.run(
    `MATCH (g:${PUBLICATION_GUARD_LABEL} {substrate_id: $substrateId})
    SET g.locked_at = $now
    ${RETURN_RECEIPT}`,
    { substrateId, now: now.toISOString() },
    (row) => row,
  );
  if (rows.length !== 1) {
    throw new PublicationInvariantError('publication_guard_missing_or_ambiguous');
  }
  return receipt(rows[0]);
}

export async function writePublicationGuardReceipt(
  tx: GraphTransaction,
  next: GuardReceipt,
): Promise<void> {
  const rows = await tx.run(
    `MATCH (g:${PUBLICATION_GUARD_LABEL} {substrate_id: $substrateId})
    WHERE g.protocol_version = $protocolVersion
    SET g.operation_id = $operationId, g.sequence = $sequence,
        g.payload_digest = $intentDigest, g.result_digest = $resultDigest
    RETURN g.substrate_id AS id`,
    { ...next },
    (row) => row.id,
  );
  if (rows.length !== 1) {
    throw new PublicationInvariantError('publication_guard_changed', next.operationId ?? undefined);
  }
}

/** Reads take no guard lock and never repair a pending operation. */
export async function readPublicationGuard(
  driver: Driver,
  substrateId: string,
  timeoutMs: number,
): Promise<GuardReceipt> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (g:${PUBLICATION_GUARD_LABEL} {substrate_id: $substrateId})
      ${RETURN_RECEIPT}`,
      { substrateId },
      { timeout: timeoutMs },
    );
    if (result.records.length !== 1) {
      throw new PublicationInvariantError('publication_guard_missing_or_ambiguous');
    }
    const row = result.records[0]?.toObject();
    if (row !== undefined && neo4j.isInt(row.protocolVersion)) {
      row.protocolVersion = row.protocolVersion.toNumber();
    }
    return receipt(row);
  } finally {
    await session.close();
  }
}

/** A fresh SQLite file cannot silently establish a second pairing over an existing graph. */
export async function publicationGuardIdentities(driver: Driver): Promise<readonly string[]> {
  const result = await driver.executeQuery(
    `MATCH (g:${PUBLICATION_GUARD_LABEL}) RETURN g.substrate_id AS id LIMIT 2`,
    {},
    { routing: neo4j.routing.READ },
  );
  return result.records.map((row) => String(row.get('id')));
}
