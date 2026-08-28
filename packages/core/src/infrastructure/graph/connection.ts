import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver';
import { NEO4J_DEFAULT_USER, type Neo4jEndpoint } from './provision.js';
import { coerceRow, type Row, type RowMapper } from './values.js';

/** A query and its parameters, built but not yet run, so the same build feeds `runWrite` and a transaction. */
export type GraphStatement = {
  readonly cypher: string;
  readonly parameters: Record<string, unknown>;
};

export type GraphHealth = {
  readonly reachable: boolean;
  readonly address?: string;
  readonly protocolVersion?: string;
  readonly agent?: string;
  readonly error?: string;
};

type RecordLike = { toObject(): Row };

function mapRecords<T>(records: readonly RecordLike[], map: RowMapper<T>): T[] {
  return records.map((record) => map(coerceRow(record.toObject())));
}

export async function runRead<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<T[]> {
  const result = await driver.executeQuery(cypher, parameters, { routing: neo4j.routing.READ });
  return mapRecords(result.records, map);
}

export async function runWrite<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<T[]> {
  const result = await driver.executeQuery(cypher, parameters, { routing: neo4j.routing.WRITE });
  return mapRecords(result.records, map);
}

export type WriteOutcome<T> = {
  readonly rows: readonly T[];
  readonly nodesCreated: number;
  readonly relationshipsCreated: number;
  readonly propertiesSet: number;
};

/**
 * The server's own counters, not an inferred diff: `MERGE` reports whether it created or
 * matched, which is how a run-twice test proves the second run wrote nothing rather than
 * guessing from timestamps that can tie.
 */
export async function runWriteWithCounters<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<WriteOutcome<T>> {
  const result = await driver.executeQuery(cypher, parameters, { routing: neo4j.routing.WRITE });
  const counters = result.summary.counters.updates();
  return {
    rows: mapRecords(result.records, map),
    nodesCreated: counters.nodesCreated,
    relationshipsCreated: counters.relationshipsCreated,
    propertiesSet: counters.propertiesSet,
  };
}

/** The one statement runner inside a managed transaction; rows come back coerced exactly as they do outside one. */
export class GraphTransaction {
  readonly #tx: ManagedTransaction;

  constructor(tx: ManagedTransaction) {
    this.#tx = tx;
  }

  async run<T>(
    cypher: string,
    parameters: Record<string, unknown>,
    map: RowMapper<T>,
  ): Promise<T[]> {
    const result = await this.#tx.run(cypher, parameters);
    return mapRecords(result.records, map);
  }

  /** The transaction-scoped twin of `runWriteWithCounters`; `MERGE` reports create versus match the same way. */
  async runWithCounters<T>(
    cypher: string,
    parameters: Record<string, unknown>,
    map: RowMapper<T>,
  ): Promise<WriteOutcome<T>> {
    const result = await this.#tx.run(cypher, parameters);
    const counters = result.summary.counters.updates();
    return {
      rows: mapRecords(result.records, map),
      nodesCreated: counters.nodesCreated,
      relationshipsCreated: counters.relationshipsCreated,
      propertiesSet: counters.propertiesSet,
    };
  }
}

/**
 * Multi-statement atomicity: `supersede` closes a node and writes its lineage edge here so
 * a crash between the two cannot leave a closed node with no replacement pointing at it.
 * Session creation and reflection intake use it for the same reason, and additionally for
 * isolation — both derive a write from a read, so both take a node lock inside the
 * transaction to keep a peer from landing between the two (`locks.ts`).
 */
export async function inWriteTransaction<T>(
  driver: Driver,
  work: (tx: GraphTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session();
  try {
    return await session.executeWrite((tx) => work(new GraphTransaction(tx)));
  } finally {
    await session.close();
  }
}

/**
 * Every timeout the driver applies while the server is gone. The driver's own defaults
 * (60s to acquire a connection, 30s of transaction retries) exceed or brush the MCP
 * client's 60s request timeout, so a tool call against a dead Neo4j either answered after
 * a minute or died on the client before the server's own named error arrived. These bound
 * the wait at the tool boundary; a healthy pool hands out a connection in microseconds, so
 * they only bite during an outage.
 */
const CONNECTION_TIMEOUT_MS = 5000;
const CONNECTION_ACQUISITION_TIMEOUT_MS = 10_000;
const MAX_TRANSACTION_RETRY_TIME_MS = 10_000;

/**
 * Owns one driver for the process. Construction performs no I/O — the driver connects
 * lazily — so `health()` is the only call that reports whether the server is actually
 * there, and it is the same check `aion doctor` and `aion status` run.
 */
export class GraphConnection {
  readonly uri: string;
  readonly #driver: Driver;

  constructor(endpoint: Neo4jEndpoint) {
    this.uri = endpoint.uri;
    this.#driver = neo4j.driver(
      endpoint.uri,
      neo4j.auth.basic(NEO4J_DEFAULT_USER, endpoint.password),
      {
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        connectionAcquisitionTimeout: CONNECTION_ACQUISITION_TIMEOUT_MS,
        maxTransactionRetryTime: MAX_TRANSACTION_RETRY_TIME_MS,
      },
    );
  }

  get driver(): Driver {
    return this.#driver;
  }

  async health(): Promise<GraphHealth> {
    try {
      const info = await this.#driver.getServerInfo();
      return {
        reachable: true,
        address: info.address ?? '',
        protocolVersion: String(info.protocolVersion ?? ''),
        agent: info.agent ?? '',
      };
    } catch (err) {
      return { reachable: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  read<T>(cypher: string, parameters: Record<string, unknown>, map: RowMapper<T>): Promise<T[]> {
    return runRead(this.#driver, cypher, parameters, map);
  }

  write<T>(cypher: string, parameters: Record<string, unknown>, map: RowMapper<T>): Promise<T[]> {
    return runWrite(this.#driver, cypher, parameters, map);
  }

  inWriteTransaction<T>(work: (tx: GraphTransaction) => Promise<T>): Promise<T> {
    return inWriteTransaction(this.#driver, work);
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }
}
