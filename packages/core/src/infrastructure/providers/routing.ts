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
 * Both roles run on the one provider `AION_GENERATION_PROVIDER` selects, and so does batched
 * description refresh: an installation chooses Anthropic or OpenAI and needs only that vendor's
 * key. The roles stay apart because they decide what a call is allowed to wait for, what it is
 * charged under, and which prompts and timeouts it uses.
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

export type RoleRoute = {
  readonly role: GenerationRole;
  readonly provider: GenerationProvider;
  /** The model the call names on that provider. */
  readonly model: string;
  /**
   * False when the selected provider has no key. Generation then has nowhere to go: the work
   * queues and says so, recall falls back to the existing ranking, and no other provider or local
   * model stands in for it.
   */
  readonly available: boolean;
};

export type ProviderRouting = {
  /** The one provider every hosted generation runs on. */
  readonly provider: GenerationProvider;
  readonly roles: Readonly<Record<GenerationRole, RoleRoute>>;
  /** Whether the selected provider has a key; the other provider's key is not consulted. */
  readonly keyPresent: boolean;
  /** Never routed: one model owns the vector space for the life of the substrate. */
  readonly embedModel: string;
};

/** The model an installation names on a provider. */
export function modelOn(config: Config, provider: GenerationProvider): string {
  return provider === 'openai' ? config.openai.model : config.anthropic.model;
}

/** Whether a provider's key is set, trimmed the way the backend will send it. */
export function providerKeyPresent(config: Config, provider: GenerationProvider): boolean {
  const key = provider === 'openai' ? config.openai.apiKey : config.anthropic.apiKey;
  return key.trim().length > 0;
}

/**
 * The whole routing rule, in one pure function of config: every role runs on the selected
 * provider at that provider's configured model, and embeddings are not part of the question. A
 * missing key does not reroute anything. It makes generation unavailable, which the queue reports
 * as lag.
 */
export function resolveProviderRouting(config: Config): ProviderRouting {
  const { provider } = config.generation;
  const keyPresent = providerKeyPresent(config, provider);
  const model = modelOn(config, provider);
  const route = (role: GenerationRole): RoleRoute => ({
    role,
    provider,
    model,
    available: keyPresent,
  });
  return {
    provider,
    roles: { cue: route('cue'), reflect: route('reflect') },
    keyPresent,
    embedModel: config.models.embed,
  };
}

function routeList(routing: ProviderRouting): readonly RoleRoute[] {
  return GENERATION_ROLES.map((role) => routing.roles[role]);
}

/** Why generation has nowhere to run, in the words an operator acts on. */
export function unavailableReason(route: Pick<RoleRoute, 'provider'>): string {
  return `AION_GENERATION_PROVIDER=${route.provider} needs ${PROVIDER_KEY_ENV_VARS[route.provider]}`;
}

/**
 * One line for a log or a status row: `cue=openai:gpt-6-luna reflect=openai:gpt-6-luna`, with
 * `queued(<provider>)` for a role whose provider has no key, which is what the substrate is
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
 * API, named as call classes rather than as role names. With no key for the selected provider it
 * prints the other half of the same fact, since an operator whose reflection backlog is not
 * draining needs to read the reason here rather than infer it from the queue depth.
 */
export function remoteBannerLines(routing: ProviderRouting): readonly string[] {
  const classes = [
    ...routeList(routing).map((route) => `           ${ROLE_CALL_CLASS[route.role]}`),
    '           batched description refresh',
  ];
  if (!routing.keyPresent) {
    return [
      `remote   ${unavailableReason(routing)}, so generation has nowhere to run:`,
      ...classes,
      '         capture, embeddings and every graph read still work. Generation work queues',
      '         until the key is set, and recall serves the existing ranking.',
    ];
  }
  return [
    `remote   generation leaves this machine for ${routing.provider} (${routing.roles.reflect.model}):`,
    ...classes,
    '         embeddings and every graph read stay local.',
  ];
}

/**
 * What the service says at boot about a route it cannot run as asked: no key for the selected
 * provider, or a model the price table does not carry, which every dispatch then holds at the top
 * of that provider's card. The provider not selected is not mentioned: its key is not needed.
 */
export function routingWarnings(routing: ProviderRouting): readonly string[] {
  const { model } = routing.roles.reflect;
  if (!routing.keyPresent) {
    return [
      `generation has nowhere to run (${unavailableReason(routing)}): capture, embedding and ` +
        'recall run, and generation work stays queued until the key is set',
    ];
  }
  if (!isPricedModel(model)) {
    return [
      `generation names ${routing.provider}:${model}, which has no price on record: each call is ` +
        "held at the top of that provider's card, so the daily ceiling admits few of them. Add " +
        'the model to api-pricing.ts to price it.',
    ];
  }
  return [];
}
