import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyGdsAvailable } from './provision.js';
import {
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

describe('neo4j integration harness', () => {
  let harness: Neo4jHarness;
  let anonymousVolumes: string[];
  let torndown = false;

  beforeAll(async () => {
    harness = await startNeo4jHarness();
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
