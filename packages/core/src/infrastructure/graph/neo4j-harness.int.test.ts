import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyGdsAvailable } from './provision.js';
import { countNodes, countRelationships } from './test-support/graph-queries.fixture.js';
import {
  startDedicatedNeo4jHarness,
  startNeo4jHarness,
  stopNeo4jHarness,
  type Neo4jHarness,
} from './test-support/neo4j-harness.fixture.js';

const execFileAsync = promisify(execFile);

/** The neo4j image declares VOLUME /data and /logs, so a bare `docker run` still gets two anonymous volumes to prove teardown removes. */
async function listMountNames(containerName: string): Promise<string[]> {
  const { stdout } = await execFileAsync('docker', [
    'inspect',
    containerName,
    '--format',
    '{{range .Mounts}}{{.Name}}\n{{end}}',
  ]);
  return stdout
    .trim()
    .split('\n')
    .filter((name) => name.length > 0);
}

describe('a neo4j container the test file owns', () => {
  let harness: Neo4jHarness;
  let anonymousVolumes: string[];
  let torndown = false;

  beforeAll(async () => {
    harness = await startDedicatedNeo4jHarness();
    anonymousVolumes = await listMountNames(harness.containerName);
  });

  afterAll(async () => {
    if (!torndown) {
      await stopNeo4jHarness(harness);
    }
  });

  it('brings up a throwaway Neo4j, connects, and confirms GDS procedures are present', async () => {
    const gdsVersion = await verifyGdsAvailable(harness.driver, harness.uri);
    expect(gdsVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('removes the container and its volumes completely on teardown', async () => {
    expect(anonymousVolumes.length).toBeGreaterThan(0);

    await stopNeo4jHarness(harness);
    torndown = true;

    await expect(execFileAsync('docker', ['inspect', harness.containerName])).rejects.toThrow();

    const { stdout } = await execFileAsync('docker', ['volume', 'ls', '-q']);
    const remainingVolumes = new Set(stdout.trim().split('\n').filter((name) => name.length > 0));
    for (const volumeName of anonymousVolumes) {
      expect(remainingVolumes.has(volumeName)).toBe(false);
    }
  });
});

/**
 * The contract every other integration file relies on, and it holds whichever path served the
 * lease: the run's shared container when the project runner published one, a fresh container
 * of this file's own when nothing did.
 */
describe('the database a test file is handed', () => {
  let harness: Neo4jHarness;

  beforeAll(async () => {
    harness = await startNeo4jHarness();
  });

  afterAll(async () => {
    await stopNeo4jHarness(harness);
  });

  it('carries no nodes and no relationships from whatever ran before it', async () => {
    expect(await countNodes(harness.driver)).toBe(0);
    expect(await countRelationships(harness.driver)).toBe(0);
  });

  it('carries no constraints and no indexes beyond the token lookups neo4j owns', async () => {
    const constraints = await harness.driver.executeQuery('SHOW CONSTRAINTS YIELD name RETURN name');
    expect(constraints.records).toEqual([]);

    const indexes = await harness.driver.executeQuery(
      "SHOW INDEXES YIELD name, type WHERE type <> 'LOOKUP' RETURN name",
    );
    expect(indexes.records.map((record) => record.get('name') as string)).toEqual([]);
  });
});
