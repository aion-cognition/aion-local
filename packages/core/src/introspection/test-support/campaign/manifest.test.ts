import { describe, expect, it } from 'vitest';

import { buildCampaignManifest, configDigest, type ManifestInput } from './manifest.js';
import { DEFAULTS } from '../../../infrastructure/config/defaults.js';
import type { Config } from '../../../infrastructure/config/schema.js';

const SECRET = 'sk-ant-not-a-real-key';

function withSecrets(config: Config): Config {
  return {
    ...config,
    neo4j: { ...config.neo4j, password: 'hunter2' },
    anthropic: { ...config.anthropic, apiKey: SECRET },
  };
}

function input(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    metricVersion: 1,
    startedAt: '2026-09-07T00:00:00.000Z',
    finishedAt: '2026-09-07T00:01:00.000Z',
    buildSha: 'abc1234',
    provenance: {
      collectorBuildSha: 'abc1234',
      deployedBuildSha: 'unknown',
      collectorArchiveSchemaVersion: 1,
      installedSqliteTables: ['experience_archive'],
      appliedGraphMigrations: ['graph:migration:001'],
    },
    config: DEFAULTS,
    substrate: {
      graphEndpoint: 'bolt://127.0.0.1:7687',
      sqlitePath: '/tmp/copy/aion.sqlite',
      sqliteSource: 'backup_api',
      sqliteAcquiredFrom: '2026-09-07T23:00:00.000Z',
      sqliteAcquiredUntil: '2026-09-07T23:00:04.000Z',
      sqliteDigest: 'f'.repeat(64),
    },
    frozen: { staleEdgeIds: ['e1', 'e2'], graphSourceIds: ['s1'], narrativeIds: ['n1'] },
    ...overrides,
  };
}

describe('the config digest', () => {
  it('changes when a knob changes', () => {
    const moved: Config = { ...DEFAULTS, recall: { ...DEFAULTS.recall, tokenBudget: 1 } };
    expect(configDigest(moved)).not.toBe(configDigest(DEFAULTS));
  });

  it('does not change when only a secret changes', () => {
    const one = withSecrets(DEFAULTS);
    const two: Config = {
      ...one,
      neo4j: { ...one.neo4j, password: 'a-different-password' },
      anthropic: { ...one.anthropic, apiKey: 'sk-ant-also-not-real' },
    };
    expect(configDigest(two)).toBe(configDigest(one));
  });

  it('still separates a secret that is set from one that is not', () => {
    expect(configDigest(withSecrets(DEFAULTS))).not.toBe(configDigest(DEFAULTS));
  });
});

describe('the campaign manifest', () => {
  it('keys on the frozen membership and the window it was read in', () => {
    const first = buildCampaignManifest(input());
    const same = buildCampaignManifest(input());
    const wider = buildCampaignManifest(
      input({ frozen: { staleEdgeIds: ['e1'], graphSourceIds: ['s1'], narrativeIds: ['n1'] } }),
    );
    expect(first.manifestId).toBe(same.manifestId);
    expect(first.manifestId).not.toBe(wider.manifestId);
  });

  it('holds the membership itself, not only a digest of it', () => {
    expect(buildCampaignManifest(input()).frozen.staleEdgeIds).toEqual(['e1', 'e2']);
  });

  it('says the readings are bounded by their window rather than a snapshot', () => {
    const manifest = buildCampaignManifest(input());
    expect(manifest.observationKind).toBe('bounded_window');
    expect(manifest.substrate.sqliteSource).toBe('backup_api');
  });

  it('records the substrate acquisition apart from the graph read window', () => {
    const manifest = buildCampaignManifest(input());
    expect(manifest.substrate.sqliteAcquiredFrom).toBe('2026-09-07T23:00:00.000Z');
    expect(manifest.substrate.sqliteAcquiredUntil).toBe('2026-09-07T23:00:04.000Z');
    expect(manifest.substrate.sqliteDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.startedAt).not.toBe(manifest.substrate.sqliteAcquiredFrom);
  });

  it('keeps the collector build apart from the one the service runs', () => {
    const manifest = buildCampaignManifest(input());
    expect(manifest.provenance.collectorBuildSha).toBe('abc1234');
    expect(manifest.provenance.deployedBuildSha).toBe('unknown');
    expect(manifest.provenance.appliedGraphMigrations).toEqual(['graph:migration:001']);
  });

  it('carries no secret value', () => {
    const manifest = buildCampaignManifest(input({ config: withSecrets(DEFAULTS) }));
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
    expect(JSON.stringify(manifest)).not.toContain('hunter2');
  });
});
