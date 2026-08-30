import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { captureConfigSurface, type ConfigSurface } from './config-surface.fixture.js';

/**
 * The committed capture is the contract. Every knob's name, path, kind, default, accepted
 * range, and rejection message is in it, so a change to how the config surface is produced is
 * a green run only if it produces the same surface. A knob deliberately added, renamed, or
 * retuned is the one reason to recapture, and the diff is then the review.
 */
const COMMITTED = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config-surface.json'), 'utf8'),
) as ConfigSurface;

describe('config surface', () => {
  const surface = captureConfigSurface();

  it('serves the same default tree', () => {
    expect(surface.defaults).toEqual(COMMITTED.defaults);
  });

  it('catalogs the same env vars against the same paths and kinds', () => {
    expect(surface.knobs).toEqual(COMMITTED.knobs);
  });

  it('returns the same verdict for every env-var probe', () => {
    expect(surface.envProbes).toEqual(COMMITTED.envProbes);
  });

  it('returns the same verdict for every bad-leaf probe', () => {
    expect(surface.schemaProbes).toEqual(COMMITTED.schemaProbes);
  });

  it('holds the loader behavior the probes cannot reach one knob at a time', () => {
    expect(surface.aggregates).toEqual(COMMITTED.aggregates);
  });
});
