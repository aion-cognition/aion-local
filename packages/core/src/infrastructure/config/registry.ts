import {
  KNOB_TABLE,
  type ConfigPath,
  type KnobDeclaration,
  type KnobKind,
  type KnobTable,
} from './knobs.js';

export type Knob = {
  envVar: string;
  path: ConfigPath;
  kind: KnobKind;
};

/**
 * How the env string is read back into the leaf's type. A scalar's decoder follows from the type
 * of its default, since that is the type its schema accepts. A knob whose one var feeds a whole
 * subtree declares its decoder instead, because no leaf type says how the parts are spelled.
 */
function knobKind(knob: KnobDeclaration): KnobKind {
  const [envVar, , value, declared] = knob;
  if (declared !== undefined) {
    return declared;
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'string') {
    return 'string';
  }
  if (Array.isArray(value)) {
    return 'stringList';
  }
  throw new Error(`${envVar} declares no kind and its default is neither a scalar nor a list`);
}

/**
 * The flat AION_* surface, one entry per Config leaf, folded out of the knob table. `weights`
 * covers the three search.weights sub-fields from a single comma-separated var; every other leaf
 * is a 1:1 var.
 *
 * A fixed set of env var names (AION_CUE_BUDGET_MS, AION_RECALL_TOKEN_BUDGET,
 * AION_SEARCH_WEIGHTS, AION_NEO4J_URI, AION_NEO4J_PASSWORD, AION_OLLAMA_URL,
 * AION_ANTHROPIC_API_KEY, AION_MAINTENANCE_TIER3, AION_MCP_PORT, AION_AUTO_MERGE) keep their
 * existing spelling; the rest follow AION_<GROUP>_<LEAF> for consistency.
 *
 * AION_REFLECTION_STAGE_TIMEOUT_MS replaced five per-stage timeout vars that all carried 60000
 * and that no deployment ever split. A stage needing its own guard takes it as a constructor
 * option, which is where a value one caller wants belongs.
 *
 * AION_MIN_RELEVANCE is gone rather than renamed. It named one floor for every search method,
 * and each method now has its own calibrated cosine floor; a stale 0.35 silently applying to a
 * calibrated floor would be worse than the error an unknown variable raises.
 *
 * AION_SUPERSEDE_AUTO_CONFIDENCE and AION_ASSOC_SEMANTIC_THRESHOLD are the same case and keep
 * their existing spelling inside the `reflection` group, as does AION_SUPERSEDE_MODE, which took
 * over the gating role the confidence knob had. The worker's knobs live under `operational` and
 * read AION_WORKER_*, which is where AION_WORKER_COUNT already was. AION_REINFORCEMENT_QUEUE_CAP
 * and AION_PACK_CLUSTER_CAP keep their existing spelling rather than
 * AION_SQLITE_REINFORCEMENT_QUEUE_CAP / AION_RECALL_CLUSTER_CAP, and AION_SEED_BUDGET_BASE /
 * AION_SEED_BUDGET_GROWTH are named for the budget they shape rather than for the group that
 * holds them alongside the cap.
 *
 * AION_DAILY_CEILING_USD names no provider because it bounds both providers' spend, while its
 * leaf still sits at `anthropic.dailyCeilingUsd` where the readers outside this package reach it.
 * The name it replaced still works through `ENV_VAR_ALIASES` below.
 */
export function buildRegistry(table: KnobTable = KNOB_TABLE): readonly Knob[] {
  const registry: Knob[] = [];
  // Two leaves declaring one variable would both be written from it, and the loader would give
  // no sign: the unknown-variable check dedupes and the schema accepts both writes. The table is
  // 150-odd leaves across three files, which is where such a collision hides.
  const claimed = new Map<string, string>();
  for (const [group, leaves] of Object.entries(table)) {
    for (const [leaf, knob] of Object.entries(leaves)) {
      const envVar = knob[0];
      const path = `${group}.${leaf}`;
      const owner = claimed.get(envVar);
      if (owner !== undefined) {
        throw new Error(`${envVar} is declared by both ${owner} and ${path}`);
      }
      claimed.set(envVar, path);
      registry.push({ envVar, path: [group, leaf], kind: knobKind(knob) });
    }
  }
  return registry;
}

export const KNOB_REGISTRY: readonly Knob[] = buildRegistry();

/**
 * AION_*-prefixed variables that `bin/aion` passes through to the container for compose
 * and the CLI, not for config: the host repo path compose interpolates its bind mount
 * from, the `git config user.name` the backbone bootstrap confirms, and facts about the
 * host the container cannot see for itself, such as whether the harness hooks are
 * installed. The last one names where a preserved capture is kept, which is a location on
 * one machine rather than a setting. They are listed here so the unknown-variable check
 * keeps catching typos in real knobs.
 */
export const RESERVED_ENV_VARS: ReadonlySet<string> = new Set([
  'AION_REPO_PATH',
  'AION_GIT_USER_NAME',
  'AION_BUILD_SHA',
  'AION_REPO_HEAD_SHA',
  'AION_HOOKS_INSTALLED',
  'AION_CAMPAIGN_INCIDENT_DIR',
]);

/**
 * Knobs that existed and were retired. A .env written against an older checkout still
 * sets them; refusing to boot over a setting that no longer does anything punishes the
 * upgrade. They parse as ignored rather than unknown, and `.env.example` no longer
 * carries them. Typos in live knobs still fail loud.
 */
export const RETIRED_ENV_VARS: ReadonlySet<string> = new Set([
  'AION_OLLAMA_MODE',
  'AION_HEBBIAN_FLUSH_INTERVAL_MS',
  'AION_CONTEXT_RESONANCE_MAX_HOPS',
  'AION_CONTEXT_RESONANCE_ACTIVATION_THRESHOLD',
  'AION_REFLECTION_ENTITY_TIMEOUT_MS',
  'AION_REFLECTION_COGNITIVE_TIMEOUT_MS',
  'AION_REFLECTION_SEMANTIC_TIMEOUT_MS',
  'AION_REFLECTION_SUPERSEDE_TIMEOUT_MS',
  'AION_REFLECTION_NARRATIVE_TIMEOUT_MS',
]);

const KNOWN_ENV_VARS: ReadonlySet<string> = new Set(KNOB_REGISTRY.map((knob) => knob.envVar));

/**
 * Older spellings that still set a live knob, each mapped to the name that replaced it. A `.env`
 * written before a rename keeps the value it holds rather than silently falling back to a default.
 * Where both spellings are set, the current name wins and `configNotices` says so when the two
 * disagree. An alias is a setting and never a credential, since the notice prints both values.
 */
export const ENV_VAR_ALIASES: ReadonlyMap<string, string> = checkedAliases(
  new Map([['AION_ANTHROPIC_DAILY_CEILING_USD', 'AION_DAILY_CEILING_USD']]),
);

function checkedAliases(aliases: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  for (const [alias, current] of aliases) {
    if (!KNOWN_ENV_VARS.has(current)) {
      throw new Error(`${alias} is an alias for ${current}, which no knob declares`);
    }
    if (KNOWN_ENV_VARS.has(alias)) {
      throw new Error(`${alias} is both an alias and a knob of its own`);
    }
  }
  return aliases;
}

/** The older spelling that still sets this knob, where it has one. */
export function aliasFor(envVar: string): string | undefined {
  for (const [alias, current] of ENV_VAR_ALIASES) {
    if (current === envVar) {
      return alias;
    }
  }
  return undefined;
}

const REGISTRY_BY_PATH: ReadonlyMap<string, Knob> = new Map(
  KNOB_REGISTRY.map((knob) => [knob.path.join('.'), knob]),
);

export function knownEnvVars(): ReadonlySet<string> {
  return KNOWN_ENV_VARS;
}

/**
 * The variable an operator would set to reach this config path. A schema issue can land inside a
 * leaf rather than on it (`search.weights.vector`, `search.methods.1`), so the lookup takes the
 * group and leaf that name the knob and leaves the rest of the path to the caller.
 */
export function envVarForPath(path: readonly string[]): string | undefined {
  return REGISTRY_BY_PATH.get(path.slice(0, 2).join('.'))?.envVar;
}
