import { GraphConnection, readNeo4jPairing } from '@aion/core';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

import { HOST_ACTIONS } from './host-actions.js';
import { applyNeo4jSettings, NEO4J_SETTINGS, resolveNeo4jLayout } from './native-graph.js';

/**
 * The native install's reads, against a native substrate that is actually there.
 *
 * Everything here is a read or a write to a copy. It never installs, starts, stops or reconfigures
 * anything: the install steps' own behaviour is unit-tested with the machine behind a seam, and
 * what this adds is the part no fake can answer — whether the layout probe finds a real
 * distribution and whether a real server's pairing reads the way the checks assume.
 *
 * It runs only when the environment names a native endpoint, because the alternative is a test
 * that reaches for whatever Neo4j happens to be on the machine, including the one an install is
 * using. The skip is printed rather than silent: a gate nobody can see is a gate nobody knows is
 * shut.
 */

/** Straight to the file descriptor: what a reporter catches, a reporter can decide not to print. */
function notice(line: string): void {
  process.stderr.write(`native substrate int: ${line}\n`);
}

const URI = (process.env.TEST_AION_NATIVE_NEO4J_URI ?? '').trim();
const PASSWORD = (process.env.TEST_AION_NATIVE_NEO4J_PASSWORD ?? '').trim();
const NEO4J_HOME = (process.env.TEST_AION_NATIVE_NEO4J_HOME ?? '').trim();
const present = URI !== '' && PASSWORD !== '';

/**
 * Always runs, and is how the skip is visible: a gated file whose cases all skip prints nothing of
 * its own, and a gate nobody can see is a gate nobody knows is shut. It also refuses a gate that
 * was half named, which is an operator mistake that would otherwise read as a clean skip.
 *
 * It writes to stderr directly rather than through `console`, because the reporter intercepts
 * `console` and the default one does not print what it catches. A skip notice only the verbose
 * reporter shows is the same invisible gate one step along.
 */
it('says whether a native substrate was offered to it', () => {
  const named = [URI, PASSWORD].filter((value) => value !== '').length;

  expect(named === 0 || named === 2).toBe(true);
  notice(
    present
      ? `RUNNING against ${URI}${NEO4J_HOME === '' ? '' : ` (${NEO4J_HOME})`}`
      : 'SKIPPED. Set TEST_AION_NATIVE_NEO4J_URI and TEST_AION_NATIVE_NEO4J_PASSWORD (and ' +
          'optionally TEST_AION_NATIVE_NEO4J_HOME) to run it against a Neo4j you manage. ' +
          'Nothing here starts or changes a server.',
  );
});

it.runIf(present)('reads the pairing off a real native server', async () => {
  const connection = new GraphConnection({ uri: URI, password: PASSWORD });
  try {
    const pairing = await readNeo4jPairing(connection.driver, URI);
    notice(JSON.stringify(pairing));

    // The requirement is that the two halves agree. Whether they are also the series this build
    // was measured on is the warning the doctor reports, not a failure here.
    expect(pairing.serverVersion).not.toBe('unknown');
    expect(pairing.matched).toBe(true);
  } finally {
    await connection.close();
  }
});

it.runIf(present && NEO4J_HOME !== '')(
  'finds the distribution and writes the substrate settings into a copy of its config',
  async () => {
    const layout = await resolveNeo4jLayout(HOST_ACTIONS, { NEO4J_HOME });
    expect(layout?.home).toBe(NEO4J_HOME);
    notice(`layout ${JSON.stringify(layout)}`);

    // The real file is copied and the copy is what gets written, so this case cannot change the
    // configuration of a server somebody is running.
    const dir = mkdtempSync(join(tmpdir(), 'aion-native-conf-'));
    try {
      const copy = join(dir, 'neo4j.conf');
      copyFileSync(layout?.confFile ?? '', copy);
      applyNeo4jSettings(copy, NEO4J_SETTINGS);
      const written = readFileSync(copy, 'utf8');

      for (const [key, value] of NEO4J_SETTINGS) {
        expect(written).toContain(`${key}=${value}`);
      }
      // Everything the server's own file said is still in it.
      for (const line of readFileSync(layout?.confFile ?? '', 'utf8').split('\n')) {
        expect(written).toContain(line);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
