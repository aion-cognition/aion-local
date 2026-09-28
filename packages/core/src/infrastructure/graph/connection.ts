import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';

import { ManagedWriteCall } from './managed-write-observations.js';
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

/** Resolves the `(statement, map)` and `(cypher, parameters, map)` call shapes `runRead`/`runWrite` both accept. */
function resolveCall<T>(
  cypherOrStatement: string | GraphStatement,
  parametersOrMap: Record<string, unknown> | RowMapper<T>,
  maybeMap: RowMapper<T> | undefined,
): { cypher: string; parameters: Record<string, unknown>; map: RowMapper<T> } {
  if (typeof cypherOrStatement === 'string') {
    if (maybeMap === undefined) {
      throw new Error('runRead/runWrite: map is required when cypher and parameters are separate');
    }
    return {
      cypher: cypherOrStatement,
      parameters: parametersOrMap as Record<string, unknown>,
      map: maybeMap,
    };
  }
  return {
    cypher: cypherOrStatement.cypher,
    parameters: cypherOrStatement.parameters,
    map: parametersOrMap as RowMapper<T>,
  };
}

/** Accepts a built `GraphStatement` directly, so a caller that only builds one to destructure it back can skip the round trip. */
export function runRead<T>(
  driver: Driver,
  statement: GraphStatement,
  map: RowMapper<T>,
): Promise<T[]>;
export function runRead<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<T[]>;
export async function runRead<T>(
  driver: Driver,
  cypherOrStatement: string | GraphStatement,
  parametersOrMap: Record<string, unknown> | RowMapper<T>,
  maybeMap?: RowMapper<T>,
): Promise<T[]> {
  const { cypher, parameters, map } = resolveCall(cypherOrStatement, parametersOrMap, maybeMap);
  const result = await driver.executeQuery(cypher, parameters, { routing: neo4j.routing.READ });
  return mapRecords(result.records, map);
}

/** The common shape behind every `rows[0] ?? default` call site: one row, or none. */
export async function readFirst<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<T | undefined> {
  const rows = await runRead(driver, cypher, parameters, map);
  return rows[0];
}

export function runWrite<T>(
  driver: Driver,
  statement: GraphStatement,
  map: RowMapper<T>,
): Promise<T[]>;
export function runWrite<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<T[]>;
export async function runWrite<T>(
  driver: Driver,
  cypherOrStatement: string | GraphStatement,
  parametersOrMap: Record<string, unknown> | RowMapper<T>,
  maybeMap?: RowMapper<T>,
): Promise<T[]> {
  const { cypher, parameters, map } = resolveCall(cypherOrStatement, parametersOrMap, maybeMap);
  const result = await driver.executeQuery(cypher, parameters, { routing: neo4j.routing.WRITE });
  return mapRecords(result.records, map);
}

/** `readFirst`'s write-routed twin: a `CALL` procedure returns one summary row, or the graph had nothing to summarize. */
export async function writeFirst<T>(
  driver: Driver,
  cypher: string,
  parameters: Record<string, unknown>,
  map: RowMapper<T>,
): Promise<T | undefined> {
  const rows = await runWrite(driver, cypher, parameters, map);
  return rows[0];
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
  readonly #tx: Pick<ManagedTransaction, 'run'>;

  constructor(tx: Pick<ManagedTransaction, 'run'>) {
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

/** What the managed transaction produced, held as a value so cleanup runs before it is raised. */
type AttemptedWrite<T> =
  | { readonly raised: false; readonly value: T }
  | { readonly raised: true; readonly error: unknown };

async function attemptWrite<T>(
  session: Session,
  call: ManagedWriteCall,
  work: (tx: GraphTransaction) => Promise<T>,
): Promise<AttemptedWrite<T>> {
  try {
    const value = await session.executeWrite((tx) =>
      call.attempt(() => work(new GraphTransaction(tx))),
    );
    return { raised: false, value };
  } catch (error) {
    return { raised: true, error };
  }
}

/**
 * Multi-statement atomicity: `supersede` closes a node and writes its lineage edge here so
 * a crash between the two cannot leave a closed node with no replacement pointing at it.
 * Session creation and reflection intake use it for the same reason, and additionally for
 * isolation: both derive a write from a read, so both take a node lock inside the
 * transaction to keep a peer from landing between the two (`locks.ts`).
 *
 * `executeWrite` replays the body on a transient failure and tells the caller nothing about
 * it, so each invocation is counted on the way through
 * (`managed-write-observations.ts`). The counting changes no outcome: the body's result and
 * its error both pass back untouched, and the retry budget is the driver's as before.
 *
 * The transaction's outcome is held rather than raised so the session is closed exactly once
 * either way, and the outcome the caller is told about is the one it actually receives. A
 * close that fails still replaces what the work produced, which is what this wrapper has
 * always done, and the counter records that as the rejection the caller got.
 */
export async function inWriteTransaction<T>(
  driver: Driver,
  work: (tx: GraphTransaction) => Promise<T>,
): Promise<T> {
  const session = driver.session();
  const call = new ManagedWriteCall(driver);
  const attempted = await attemptWrite(session, call, work);
  try {
    await session.close();
  } catch (closeError) {
    call.settled('rejected');
    throw closeError;
  }
  if (attempted.raised) {
    call.settled('rejected');
    throw attempted.error;
  }
  call.settled('fulfilled');
  return attempted.value;
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
 * Owns one driver for the process. Construction performs no I/O (the driver connects
 * lazily), so `health()` is the only call that reports whether the server is actually
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

  /**
   * One `health()` on a driver of its own, closed before the answer returns. A caller asking only
   * whether the server answers has no use for the driver afterwards, and an open one keeps the
   * event loop alive: the command that probed prints its last line and never exits.
   */
  static async probe(endpoint: Neo4jEndpoint): Promise<GraphHealth> {
    const connection = new GraphConnection(endpoint);
    try {
      return await connection.health();
    } finally {
      await connection.close();
    }
  }

  async close(): Promise<void> {
    await this.#driver.close();
  }
}
