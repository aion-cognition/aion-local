import { DEFAULTS } from './defaults.js';
import { ConfigError, loadConfig } from './load-config.js';
import { KNOB_REGISTRY, RESERVED_ENV_VARS, RETIRED_ENV_VARS, type Knob } from './registry.js';
import { ConfigSchema } from './schema.js';

/**
 * A mechanical capture of everything the config surface promises: the default tree, the flat
 * env-var catalog, and the verdict the loader and the schema return for a fixed probe set.
 * The capture is committed as JSON so a refactor that rewrites how the surface is produced has
 * to reproduce it value for value.
 *
 * The probes are deliberately dumb. Every knob gets the same short list of values for its kind,
 * including values it accepts, so the capture pins the ranges and enums each leaf enforces
 * rather than only the ones a hand-written test remembered to name.
 */
export type ConfigSurface = {
  defaults: unknown;
  knobs: readonly string[];
  envProbes: Record<string, string>;
  schemaProbes: Record<string, string>;
  aggregates: Record<string, string>;
};

type MutableConfig = Record<string, Record<string, unknown>>;

const ENV_PROBES: Record<string, readonly string[]> = {
  string: ['', 'zzz', 'x'],
  number: ['not-a-number', '', '-1', '0', '0.5', '1.5', '2'],
  boolean: ['true', 'false', 'yes', '1'],
  stringList: ['', 'vector', 'vector, bm25', 'vector,nope'],
  weights: ['0.4,0.3,0.3', '0.5,0.5', '0.5,x,0.2', '2,0,0', '0.5, 0.25, 0.25'],
};

const LEAF_PROBES: Record<string, readonly unknown[]> = {
  string: ['', 42, null],
  number: [-1, 0, 0.5, 1.5, 2, Number.NaN, 'text'],
  boolean: ['true', 1],
  stringList: [[], ['nope'], 'vector'],
  weights: [{ vector: 2, bm25: 0.3, graph: 0.3 }, { vector: 0.4, bm25: 0.3 }, 0.4],
};

function label(value: unknown): string {
  if (typeof value === 'number' && Number.isNaN(value)) {
    return 'NaN';
  }
  if (value === undefined) {
    return 'undefined';
  }
  return JSON.stringify(value);
}

function leafValue(config: unknown, knob: Knob): unknown {
  const [group, leaf] = knob.path;
  return (config as MutableConfig)[group]?.[leaf];
}

function verdict(run: () => unknown): string {
  try {
    return `ok ${label(run())}`;
  } catch (error) {
    if (error instanceof ConfigError) {
      return `ConfigError ${error.message}`;
    }
    return `threw ${String(error)}`;
  }
}

function sortedKnobs(): readonly Knob[] {
  return [...KNOB_REGISTRY].sort((left, right) => left.envVar.localeCompare(right.envVar));
}

/** Encodes a default back into the env-var spelling its knob reads, so the decode round-trips. */
function encodeDefault(knob: Knob): string {
  const value = leafValue(DEFAULTS, knob);
  if (knob.kind === 'weights') {
    const weights = value as { vector: number; bm25: number; graph: number };
    return `${String(weights.vector)},${String(weights.bm25)},${String(weights.graph)}`;
  }
  if (knob.kind === 'stringList') {
    return (value as readonly string[]).join(',');
  }
  return String(value);
}

function envProbes(): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const knob of sortedKnobs()) {
    for (const probe of ENV_PROBES[knob.kind] ?? []) {
      captured[`${knob.envVar}=${probe}`] = verdict(() =>
        leafValue(loadConfig({ [knob.envVar]: probe }), knob),
      );
    }
  }
  return captured;
}

function schemaProbes(): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const knob of sortedKnobs()) {
    const [group, leaf] = knob.path;
    for (const probe of LEAF_PROBES[knob.kind] ?? []) {
      const candidate = structuredClone(DEFAULTS) as unknown as MutableConfig;
      const section = candidate[group];
      if (section === undefined) {
        throw new Error(`no config group named ${group}`);
      }
      section[leaf] = probe;
      const result = ConfigSchema.safeParse(candidate);
      captured[`${group}.${leaf}=${label(probe)}`] = result.success
        ? 'ok'
        : result.error.issues
            .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
            .join(' | ');
    }
  }
  return captured;
}

function roundTrip(): string {
  const env: NodeJS.ProcessEnv = {};
  for (const knob of KNOB_REGISTRY) {
    env[knob.envVar] = encodeDefault(knob);
  }
  return verdict(() => JSON.stringify(loadConfig(env)) === JSON.stringify(DEFAULTS));
}

function aggregates(): Record<string, string> {
  const retired = [...RETIRED_ENV_VARS].sort();
  const reserved = [...RESERVED_ENV_VARS].sort();
  return {
    'empty env equals DEFAULTS': verdict(
      () => JSON.stringify(loadConfig({})) === JSON.stringify(DEFAULTS),
    ),
    'non-AION vars ignored': verdict(
      () =>
        JSON.stringify(loadConfig({ PATH: '/usr/bin', HOME: '/root' })) ===
        JSON.stringify(DEFAULTS),
    ),
    'every default round-trips through its env var': roundTrip(),
    'one unknown var': verdict(() => loadConfig({ AION_NOT_A_REAL_KNOB: '1' })),
    'two unknown vars sort': verdict(() => loadConfig({ AION_ZEBRA: '1', AION_APPLE: '2' })),
    'undefined-valued AION var': verdict(
      () => JSON.stringify(loadConfig({ AION_NEO4J_URI: undefined })) === JSON.stringify(DEFAULTS),
    ),
    'two bad vars in one error': verdict(() =>
      loadConfig({ AION_RECALL_MAX_HOPS: 'bad', AION_VECTOR_ADMISSION_FLOOR: '9' }),
    ),
    'retired vars boot': verdict(() => {
      const env: NodeJS.ProcessEnv = {};
      for (const name of retired) {
        env[name] = 'whatever';
      }
      return JSON.stringify(loadConfig(env)) === JSON.stringify(DEFAULTS);
    }),
    'retired var list': retired.join(', '),
    'reserved vars boot': verdict(() => {
      const env: NodeJS.ProcessEnv = {};
      for (const name of reserved) {
        env[name] = 'whatever';
      }
      return JSON.stringify(loadConfig(env)) === JSON.stringify(DEFAULTS);
    }),
    'reserved var list': reserved.join(', '),
    'schema accepts DEFAULTS': ConfigSchema.safeParse(DEFAULTS).success ? 'ok' : 'rejected',
    'schema rejects an empty object': ConfigSchema.safeParse({}).success ? 'ok' : 'rejected',
    'default key order': Object.entries(DEFAULTS as unknown as MutableConfig)
      .map(([group, section]) => `${group}: ${Object.keys(section).join(',')}`)
      .join(' | '),
  };
}

export function captureConfigSurface(): ConfigSurface {
  return {
    defaults: JSON.parse(JSON.stringify(DEFAULTS)) as unknown,
    knobs: sortedKnobs().map((knob) => `${knob.envVar} -> ${knob.path.join('.')} : ${knob.kind}`),
    envProbes: envProbes(),
    schemaProbes: schemaProbes(),
    aggregates: aggregates(),
  };
}
