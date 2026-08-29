import {
  removeNeo4jContainer,
  startNeo4jContainer,
  type Neo4jTestContainer,
} from './neo4j-container.fixture.js';
import {
  SHARED_NEO4J_CONTAINER_ENV,
  SHARED_NEO4J_PASSWORD_ENV,
  SHARED_NEO4J_URI_ENV,
} from './neo4j-harness.fixture.js';

/**
 * One Neo4j for the whole integration run, in place of the container every file used to boot
 * and throw away. Booting is the expensive part at roughly twenty seconds a file; clearing the
 * database between files costs under a second.
 *
 * The container is handed over blank rather than migrated. Files declare their own schema at
 * their own vector dimension and they do not agree on one, so a schema created here is dropped
 * by the first file to take the lease anyway. Each file's own `runGraphMigrations` call is what
 * builds the schema it needs, exactly as it did against a container of its own.
 *
 * This runs in the vitest main process, before any worker starts, so the address it writes to
 * the environment is inherited by every file. Teardown runs after the last file.
 */
let container: Neo4jTestContainer | undefined;

export async function setup(): Promise<void> {
  container = await startNeo4jContainer();
  process.env[SHARED_NEO4J_URI_ENV] = container.uri;
  process.env[SHARED_NEO4J_PASSWORD_ENV] = container.password;
  process.env[SHARED_NEO4J_CONTAINER_ENV] = container.containerName;
}

export async function teardown(): Promise<void> {
  if (container === undefined) {
    return;
  }
  await removeNeo4jContainer(container.containerName);
  container = undefined;
}
