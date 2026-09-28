import { isPricedModel } from './api-pricing.js';
import type { GenerationProvider } from './types.js';
import type { Config } from '../config/schema.js';

/**
 * The two generation roles the substrate has. Every reflection sub-stage (entities, cognitive
 * extraction, semantic relationships, supersession judgments, narratives) is one role: they run
 * off the hot path, at one cadence, and a per-stage pin would be a knob nobody could reason
 * about. Recall's model call is the other role, because it is the one generation on the hot path
 * and the only one under a latency budget. The role keeps its first name, `cue`, because the
 * generation counters a substrate already holds are keyed on it.
 *
 * Each role names its provider (`AION_RECALL_PROVIDER`, `AION_REFLECT_PROVIDER`), and the provider
 * names the model. The split also decides what a call is allowed to wait for: a recall call is a
 * foreground request, and reflect work is background work that can be batched at half price.
 */
export const GENERATION_ROLES = ['cue', 'reflect'] as const;

export type GenerationRole = (typeof GENERATION_ROLES)[number];

/** What each role's generations are, in the words the banner uses. */
const ROLE_CALL_CLASS: Readonly<Record<GenerationRole, string>> = {
  cue: 'recall (candidate assessment or cue extraction over the query text)',
  reflect:
    'reflection extraction and session narratives (episode text: entities, decisions, relationships, contradictions)',
};

/** The variable that holds each provider's key, for the message that says which one is missing. */
export const PROVIDER_KEY_ENV_VARS: Readonly<Record<GenerationProvider, string>> = {
  anthropic: 'AION_ANTHROPIC_API_KEY',
  openai: 'AION_OPENAI_API_KEY',
};

const ROLE_PROVIDER_ENV_VARS: Readonly<Record<GenerationRole, string>> = {
  cue: 'AION_RECALL_PROVIDER',
  reflect: 'AION_REFLECT_PROVIDER',
};

export type RoleRoute = {
  readonly role: GenerationRole;
  readonly provider: GenerationProvider;
  /** The model the call names on that provider. */
  readonly model: string;
  /**
   * False when the role's provider has no key. Generation then has nowhere to go: the work
   * queues and says so, recall falls back to the existing ranking, and no other provider or local
   * model stands in for it.
   */
  readonly available: boolean;
};

export type ProviderRouting = {
  readonly roles: Readonly<Record<GenerationRole, RoleRoute>>;
  /** Whether each provider has a key, whether or not a role is routed to it. */
  readonly keys: Readonly<Record<GenerationProvider, boolean>>;
  /** True when every role has somewhere to run. */
  readonly keyPresent: boolean;
  /** Never routed: one model owns the vector space for the life of the substrate. */
  readonly embedModel: string;
};

function roleProvider(config: Config, role: GenerationRole): GenerationProvider {
  return role === 'cue' ? config.generation.recallProvider : config.generation.reflectProvider;
}

function modelOn(config: Config, provider: GenerationProvider): string {
  return provider === 'openai' ? config.openai.model : config.anthropic.model;
}

/**
 * The whole routing rule, in one pure function of config: each role runs on the provider its knob
 * names, at that provider's configured model, and embeddings are not part of the question. A
 * missing key does not reroute anything. It makes that role's generation unavailable, which the
 * queue reports as lag.
 */
export function resolveProviderRouting(config: Config): ProviderRouting {
  const keys = {
    anthropic: config.anthropic.apiKey.trim().length > 0,
    openai: config.openai.apiKey.trim().length > 0,
  };
  const route = (role: GenerationRole): RoleRoute => {
    const provider = roleProvider(config, role);
    return { role, provider, model: modelOn(config, provider), available: keys[provider] };
  };
  const roles = { cue: route('cue'), reflect: route('reflect') };
  return {
    roles,
    keys,
    keyPresent: roles.cue.available && roles.reflect.available,
    embedModel: config.models.embed,
  };
}

function routeList(routing: ProviderRouting): readonly RoleRoute[] {
  return GENERATION_ROLES.map((role) => routing.roles[role]);
}

/** Why a role has nowhere to run, in the words an operator acts on. */
export function unavailableReason(route: RoleRoute): string {
  return `${ROLE_PROVIDER_ENV_VARS[route.role]}=${route.provider} needs ${PROVIDER_KEY_ENV_VARS[route.provider]}`;
}

/**
 * One line for a log or a status row: `cue=anthropic:claude-haiku-4-5 reflect=openai:gpt-6-luna`,
 * with `queued(<provider>)` for a role whose provider has no key, which is what the substrate is
 * actually doing.
 */
export function routingSummary(routing: ProviderRouting): string {
  return routeList(routing)
    .map(
      (route) =>
        `${route.role}=${route.available ? `${route.provider}:${route.model}` : `queued(${route.provider})`}`,
    )
    .join(' ');
}

/**
 * What `aion status` prints about generation: which call classes leave the machine and for which
 * API, named as call classes rather than as role names, and which have nowhere to run. An operator
 * whose reflection backlog is not draining needs to read the reason here rather than infer it from
 * the queue depth.
 */
export function remoteBannerLines(routing: ProviderRouting): readonly string[] {
  const lines: string[] = [];
  for (const route of routeList(routing)) {
    lines.push(
      route.available
        ? `remote   ${route.provider} (${route.model}): ${ROLE_CALL_CLASS[route.role]}`
        : `remote   nowhere to run, ${unavailableReason(route)}: ${ROLE_CALL_CLASS[route.role]}`,
    );
  }
  if (routing.roles.reflect.provider !== 'anthropic') {
    lines.push(
      routing.keys.anthropic
        ? '         description refresh stays on the Anthropic batch route (its own lane).'
        : '         description refresh stays on the Anthropic batch route, which cannot run ' +
            'without AION_ANTHROPIC_API_KEY.',
    );
  }
  if (!routing.keyPresent) {
    lines.push(
      '         capture, embeddings and every graph read still work. Unrouted generation work',
      '         queues until its key is set, and recall serves the existing ranking.',
    );
    return lines;
  }
  lines.push('         embeddings and every graph read stay local.');
  return lines;
}

/**
 * What the service says at boot about a route it cannot run as asked: a role with no key for its
 * provider, and a role naming a model the price table does not carry, which every dispatch then
 * holds at the top of that provider's card.
 */
export function routingWarnings(routing: ProviderRouting): readonly string[] {
  const warnings: string[] = [];
  for (const route of routeList(routing)) {
    if (!route.available) {
      warnings.push(
        `${route.role} generation has nowhere to run (${unavailableReason(route)}): capture, ` +
          'embedding and recall run, and that generation stays queued until the key is set',
      );
    } else if (!isPricedModel(route.model)) {
      warnings.push(
        `${route.role} generation names ${route.provider}:${route.model}, which has no price on ` +
          "record: each call is held at the top of that provider's card, so the daily ceiling " +
          'admits few of them. Add the model to api-pricing.ts to price it.',
      );
    }
  }
  if (!routing.keys.anthropic && routing.roles.reflect.available) {
    warnings.push(
      'description refresh runs on the Anthropic batch route, and no AION_ANTHROPIC_API_KEY is ' +
        'set: its work stays queued until one is',
    );
  }
  return warnings;
}
