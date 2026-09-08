import { randomUUID } from 'node:crypto';

import type { SqliteHandle } from './database.js';

/**
 * The coverage control record: how far back a reader may claim history reaches.
 *
 * The current record is the highest registry revision, and a revision is added rather than
 * edited, so what a reader was told at some past moment stays readable. The wire contract
 * version stays 1 through all of it: adding a revision is a change to what the substrate
 * covers, not to the shape the answer is spoken in.
 *
 * A preparing record carries no boundary at all. Writing a placeholder for one would invent a
 * moment history started, and a reader cannot tell an invented boundary from a measured one.
 * Activation writes the boundary, the activation time and a fresh epoch together, in one
 * transaction.
 */
export const COVERAGE_WIRE_CONTRACT_VERSION = 1;

export type CoverageContractRecord = {
  readonly registryRevision: number;
  readonly contractVersion: number;
  /** An equality fence. A reader holding an older epoch is out of date whatever else matches. */
  readonly epoch: string;
  readonly historySince: string | null;
  readonly activatedAt: string | null;
  readonly fieldPolicyVersion: number;
  readonly state: 'preparing' | 'active';
};

type ContractRowData = {
  registry_revision: number;
  contract_version: number;
  epoch: string;
  history_since: string | null;
  activated_at: string | null;
  field_policy_version: number;
  state: 'preparing' | 'active';
};

const SELECT_COLUMNS = `registry_revision, contract_version, epoch, history_since, activated_at,
  field_policy_version, state`;

function toRecord(row: ContractRowData): CoverageContractRecord {
  return {
    registryRevision: row.registry_revision,
    contractVersion: row.contract_version,
    epoch: row.epoch,
    historySince: row.history_since,
    activatedAt: row.activated_at,
    fieldPolicyVersion: row.field_policy_version,
    state: row.state,
  };
}

/** The record in force: the highest registry revision, whatever state it is in. */
export function readCurrentCoverageContract(db: SqliteHandle): CoverageContractRecord | undefined {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM coverage_contract ORDER BY registry_revision DESC LIMIT 1`,
    )
    .get() as ContractRowData | undefined;
  return row === undefined ? undefined : toRecord(row);
}

export function readCoverageContractRevision(
  db: SqliteHandle,
  registryRevision: number,
): CoverageContractRecord | undefined {
  const row = db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM coverage_contract WHERE registry_revision = ?`)
    .get(registryRevision) as ContractRowData | undefined;
  return row === undefined ? undefined : toRecord(row);
}

function insert(
  db: SqliteHandle,
  values: {
    epoch: string;
    historySince: string | null;
    activatedAt: string | null;
    fieldPolicyVersion: number;
    state: 'preparing' | 'active';
  },
): CoverageContractRecord {
  const result = db
    .prepare(
      `INSERT INTO coverage_contract
         (contract_version, epoch, history_since, activated_at, field_policy_version, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      COVERAGE_WIRE_CONTRACT_VERSION,
      values.epoch,
      values.historySince,
      values.activatedAt,
      values.fieldPolicyVersion,
      values.state,
    );
  return {
    registryRevision: Number(result.lastInsertRowid),
    contractVersion: COVERAGE_WIRE_CONTRACT_VERSION,
    epoch: values.epoch,
    historySince: values.historySince,
    activatedAt: values.activatedAt,
    fieldPolicyVersion: values.fieldPolicyVersion,
    state: values.state,
  };
}

/** Opens a preparing revision. It answers reads as preparing until an activation follows it. */
export function prepareCoverageContract(
  db: SqliteHandle,
  fieldPolicyVersion: number,
): CoverageContractRecord {
  return db
    .transaction((): CoverageContractRecord =>
      insert(db, {
        epoch: randomUUID(),
        historySince: null,
        activatedAt: null,
        fieldPolicyVersion,
        state: 'preparing',
      }),
    )
    .immediate();
}

export type CoverageActivation = {
  /** The moment history is claimed from, and the activation time. They are the same moment. */
  readonly activatedAt: Date;
  readonly fieldPolicyVersion: number;
};

/**
 * Activates coverage as a new revision, with the boundary, the activation time and a fresh
 * epoch written together. The epoch changes on every activation, so a reader that cached the
 * preparing record cannot carry its fence across the boundary.
 */
export function activateCoverageContract(
  db: SqliteHandle,
  activation: CoverageActivation,
): CoverageContractRecord {
  return db
    .transaction((): CoverageContractRecord => {
      const at = activation.activatedAt.toISOString();
      return insert(db, {
        epoch: randomUUID(),
        historySince: at,
        activatedAt: at,
        fieldPolicyVersion: activation.fieldPolicyVersion,
        state: 'active',
      });
    })
    .immediate();
}

/** Whether a reader's fence still matches the record in force. */
export function coverageEpochIsCurrent(db: SqliteHandle, epoch: string): boolean {
  return readCurrentCoverageContract(db)?.epoch === epoch;
}
