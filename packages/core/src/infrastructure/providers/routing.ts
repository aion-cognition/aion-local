import type { Config } from '../config/schema.js';

/**
 * The two generation roles the substrate has. Every reflection sub-stage (entities, cognitive
 * extraction, semantic relationships, supersession judgments, narratives) is one role: they run
 * on one model, at one cadence, off the hot path, and a per-stage pin would be a knob nobody
 * could reason about. Recall's cue call is the other role, because it is the one generation on
 * the hot path and the only one under a latency budget.
 */
export const GENERATION_ROLES = ['cue', 'reflect'] as const;

export type GenerationRole = (typeof GENERATION_ROLES)[number];

export type ProviderName = 'ollama' | 'anthropic';

/** `auto` follows the key; the two provider names pin the role whatever the key says. */
export type ProviderPin = 'auto' | ProviderName;

/**
 * Why a role resolved where it did. `pin-without-key` is the one case where the answer differs
 * from what was asked for: a role pinned to Anthropic with no key routes local rather than
 * failing the boot, and `aion status` and `aion doctor` say so. Routing local is the safe
 * direction of that mistake, since nothing leaves the machine.
 */
export type RouteReason =
  'local-default' | 'key' | 'pinned-local' | 'pinned-remote' | 'pin-without-key';

export type RoleRoute = {
  readonly role: GenerationRole;
  readonly provider: ProviderName;
  /** The model the call names: the Anthropic model remotely, the Ollama tag locally. */
  readonly model: string;
  /** The Ollama tag configured for this role, whichever way it routes. */
  readonly localModel: string;
  readonly reason: RouteReason;
};

export type ProviderRouting = {
  readonly roles: Readonly<Record<GenerationRole, RoleRoute>>;
  readonly keyPresent: boolean;
  /** Never routed: one model owns the vector space for the life of the substrate. */
  readonly embedModel: string;
};

/** What each role's generations are, in the words the banner uses. */
const ROLE_CALL_CLASS: Readonly<Record<GenerationRole, string>> = {
  cue: 'recall cue extraction (the query text)',
  reflect:
    'reflection extraction and session narratives (episode text: entities, decisions, relationships, contradictions)',
};

function localModelFor(config: Config, role: GenerationRole): string {
  return role === 'cue' ? config.models.cue : config.models.reflect;
}

function resolveRole(config: Config, role: GenerationRole, keyPresent: boolean): RoleRoute {
  const localModel = localModelFor(config, role);
  const local = (reason: RouteReason): RoleRoute => {
    return { role, provider: 'ollama', model: localModel, localModel, reason };
  };
  const pin: ProviderPin = config.routing[role];

  if (pin === 'ollama') {
    return local('pinned-local');
  }
  if (pin === 'anthropic') {
    if (!keyPresent) {
      return local('pin-without-key');
    }
    return {
      role,
      provider: 'anthropic',
      model: config.anthropic.model,
      localModel,
      reason: 'pinned-remote',
    };
  }
  if (!keyPresent) {
    return local('local-default');
  }
  return { role, provider: 'anthropic', model: config.anthropic.model, localModel, reason: 'key' };
}

/**
 * The whole routing rule, in one pure function of config: an Anthropic key routes every
 * generation role to the configured Anthropic model, a per-role pin overrides that in either
 * direction, and embeddings are not part of the question.
 */
export function resolveProviderRouting(config: Config): ProviderRouting {
  const keyPresent = config.anthropic.apiKey.trim().length > 0;
  return {
    roles: {
      cue: resolveRole(config, 'cue', keyPresent),
      reflect: resolveRole(config, 'reflect', keyPresent),
    },
    keyPresent,
    embedModel: config.models.embed,
  };
}

export function routeFor(routing: ProviderRouting, role: GenerationRole): RoleRoute {
  return routing.roles[role];
}

function routeList(routing: ProviderRouting): readonly RoleRoute[] {
  return GENERATION_ROLES.map((role) => routing.roles[role]);
}

export function remoteRoutes(routing: ProviderRouting): readonly RoleRoute[] {
  return routeList(routing).filter((route) => route.provider === 'anthropic');
}

/** Roles that ask a pinned remote provider for a key that is not set. */
export function unbackedPins(routing: ProviderRouting): readonly RoleRoute[] {
  return routeList(routing).filter((route) => route.reason === 'pin-without-key');
}

/**
 * The Ollama chat models routing still needs: what `aion init` pulls and what `aion doctor`
 * round-trips. A model no role routes to locally is neither pulled nor checked, which is what
 * keeps a key-covered install from downloading 5GB of instruct weights it will never call.
 */
export function localChatModels(routing: ProviderRouting): readonly string[] {
  return [
    ...new Set(
      routeList(routing)
        .filter((route) => route.provider === 'ollama')
        .map((route) => route.localModel),
    ),
  ];
}

/** Embed always, plus whatever chat models are still local. The full init pull list. */
export function modelsToPull(routing: ProviderRouting): readonly string[] {
  return [...new Set([routing.embedModel, ...localChatModels(routing)])];
}

/**
 * Models a remote-routed role would have used and nothing local still needs. Reconciliation
 * unloads these from memory when they are resident. The embed model is excluded by
 * construction, and so is any model another role still routes to locally: a machine where cue
 * and reflect share one tag and only one of them routes remotely evicts nothing.
 */
export function evictableModels(routing: ProviderRouting): readonly string[] {
  const stillLocal = new Set([routing.embedModel, ...localChatModels(routing)]);
  return [
    ...new Set(
      remoteRoutes(routing)
        .map((route) => route.localModel)
        .filter((model) => !stillLocal.has(model)),
    ),
  ];
}

/** One line for a log or a status row: `cue=anthropic:claude-haiku-4-5 reflect=ollama:qwen3:8b`. */
export function routingSummary(routing: ProviderRouting): string {
  return routeList(routing)
    .map((route) => `${route.role}=${route.provider}:${route.model}`)
    .join(' ');
}

/**
 * What `aion status` prints when a key is set: which call classes leave the machine, named as
 * call classes rather than as role names, and what does not. An install with no remote role
 * gets nothing, since a banner that prints on a fully local machine teaches people to skip it.
 */
export function remoteBannerLines(routing: ProviderRouting): readonly string[] {
  const remote = remoteRoutes(routing);
  if (remote.length === 0) {
    return [];
  }
  const models = [...new Set(remote.map((route) => route.model))].join(', ');
  return [
    `remote   generation leaves this machine for the Anthropic API (${models}):`,
    ...remote.map((route) => `           ${ROLE_CALL_CLASS[route.role]}`),
    '         embeddings and every graph read stay local.',
  ];
}
