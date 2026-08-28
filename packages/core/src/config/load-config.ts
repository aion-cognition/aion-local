import { DEFAULTS } from './defaults.js';
import { envVarForPath, knownEnvVars, KNOB_REGISTRY, type Knob, type KnobKind } from './registry.js';
import { ConfigSchema, type Config } from './schema.js';

const AION_PREFIX = 'AION_';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Converts one env-var string into the shape its Config leaf expects. Type mismatches
 * (bad numbers, bad booleans) are deliberately passed through as-is rather than
 * rejected here — ConfigSchema.safeParse produces the precise per-field error, and
 * loadConfig re-attaches the env var name to it. `weights` is shape-checked here
 * because a wrong part count has no single corresponding zod leaf to blame.
 */
function parseRaw(raw: string, kind: KnobKind, envVar: string): unknown {
  switch (kind) {
    case 'string':
      return raw;
    case 'number':
      return raw.trim() === '' ? NaN : Number(raw);
    case 'boolean':
      if (raw === 'true') {
        return true;
      }
      if (raw === 'false') {
        return false;
      }
      return raw;
    case 'stringList':
      return raw.split(',').map((part) => part.trim());
    case 'weights': {
      const parts = raw.split(',').map((part) => part.trim());
      if (parts.length !== 3) {
        throw new ConfigError(
          `${envVar}: expected 3 comma-separated numbers (vector,bm25,graph), received "${raw}"`,
        );
      }
      const numbers = parts.map(Number);
      const vector = numbers[0] ?? NaN;
      const bm25 = numbers[1] ?? NaN;
      const graph = numbers[2] ?? NaN;
      if ([vector, bm25, graph].some((n) => Number.isNaN(n))) {
        throw new ConfigError(
          `${envVar}: expected 3 comma-separated numbers (vector,bm25,graph), received "${raw}"`,
        );
      }
      return { vector, bm25, graph };
    }
    default: {
      const exhaustive: never = kind;
      throw new ConfigError(`unhandled knob kind: ${String(exhaustive)}`);
    }
  }
}

function setAtPath(target: Record<string, Record<string, unknown>>, knob: Knob, value: unknown): void {
  const [group, leaf] = knob.path;
  const section = target[group];
  if (section === undefined) {
    throw new ConfigError(`registry path points at an unknown config group: ${group}`);
  }
  section[leaf] = value;
}

function collectUnknownVars(env: NodeJS.ProcessEnv): string[] {
  const known = knownEnvVars();
  const unknown: string[] = [];
  for (const key of Object.keys(env)) {
    if (key.startsWith(AION_PREFIX) && env[key] !== undefined && !known.has(key)) {
      unknown.push(key);
    }
  }
  return unknown.sort();
}

/**
 * The only place AION_* env vars are read into typed config. Every leaf in
 * ConfigSchema has exactly one entry in KNOB_REGISTRY; an AION_* var with no
 * matching entry is rejected rather than silently ignored.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const unknownVars = collectUnknownVars(env);
  if (unknownVars.length > 0) {
    throw new ConfigError(`Unknown AION_* environment variable(s): ${unknownVars.join(', ')}`);
  }

  const merged = structuredClone(DEFAULTS) as unknown as Record<string, Record<string, unknown>>;
  for (const knob of KNOB_REGISTRY) {
    const raw = env[knob.envVar];
    if (raw === undefined) {
      continue;
    }
    setAtPath(merged, knob, parseRaw(raw, knob.kind, knob.envVar));
  }

  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.map(String);
      const label = envVarForPath(path) ?? path.join('.');
      return `${label}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }

  return result.data;
}
