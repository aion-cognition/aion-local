import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEnvDefaults } from '../env-file.js';

/**
 * vitest loads no `.env`, so a run started on the host used to need the key exported by hand,
 * and a forgotten export dropped generation to the local model with nothing said. This runs as
 * a setup file, before any test module is imported, so a battery that reads the key at module
 * scope sees the loaded value.
 *
 * Two keys and no more. The throwaway Neo4j containers carry credentials of their own, and a
 * setting sitting in the file would change a run without saying so. An exported value wins over
 * the file.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));

applyEnvDefaults(join(REPO_ROOT, '.env'), ['AION_ANTHROPIC_API_KEY', 'AION_ANTHROPIC_MODEL']);
