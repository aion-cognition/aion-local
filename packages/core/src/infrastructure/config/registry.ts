import { KNOB_TABLE, type ConfigPath, type KnobDeclaration, type KnobKind } from './knobs.js';

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
 * AION_ANTHROPIC_API_KEY, AION_MAINTENANCE_TIER3, AION_MCP_PORT) keep their existing spelling;
 * the rest follow AION_<GROUP>_<LEAF> for consistency.
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
 */
function buildRegistry(): readonly Knob[] {
  const registry: Knob[] = [];
  for (const [group, leaves] of Object.entries(KNOB_TABLE)) {
    for (const [leaf, knob] of Object.entries(leaves)) {
      registry.push({ envVar: knob[0], path: [group, leaf], kind: knobKind(knob) });
    }
  }
  return registry;
}

export const KNOB_REGISTRY: readonly Knob[] = buildRegistry();

/**
 * AION_*-prefixed variables that `bin/aion` passes through to the container for compose
 * and the CLI, not for config: the host repo path compose interpolates its bind mount
 * from, and the `git config user.name` the backbone bootstrap confirms. They are listed
 * here so the unknown-variable check keeps catching typos in real knobs.
 */
export const RESERVED_ENV_VARS: ReadonlySet<string> = new Set([
  'AION_REPO_PATH',
  'AION_GIT_USER_NAME',
  'AION_BUILD_SHA',
  'AION_REPO_HEAD_SHA',
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

const registryByEnvVar = new Map(KNOB_REGISTRY.map((knob) => [knob.envVar, knob]));

export function knownEnvVars(): ReadonlySet<string> {
  return new Set(registryByEnvVar.keys());
}

export function envVarForPath(path: readonly string[]): string | undefined {
  const joined = path.join('.');
  const match = KNOB_REGISTRY.find((knob) => knob.path.join('.') === joined);
  return match?.envVar;
}
