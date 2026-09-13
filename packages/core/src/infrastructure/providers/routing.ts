import type { Config } from '../config/schema.js';

/**
 * The two generation roles the substrate has. Every reflection sub-stage (entities, cognitive
 * extraction, semantic relationships, supersession judgments, narratives) is one role: they run
 * off the hot path, at one cadence, and a per-stage pin would be a knob nobody could reason
 * about. Recall's cue call is the other role, because it is the one generation on the hot path
 * and the only one under a latency budget.
 *
 * Both roles name the same model. The split survives because it decides what a call is allowed
 * to wait for: a cue call is a foreground request, and reflect work is background work that can
 * be batched at half price.
 */
export const GENERATION_ROLES = ['cue', 'reflect'] as const;

export type GenerationRole = (typeof GENERATION_ROLES)[number];

/** What each role's generations are, in the words the banner uses. */
const ROLE_CALL_CLASS: Readonly<Record<GenerationRole, string>> = {
  cue: 'recall cue extraction (the query text)',
  reflect:
    'reflection extraction and session narratives (episode text: entities, decisions, relationships, contradictions)',
};

export type RoleRoute = {
  readonly role: GenerationRole;
  /** The Anthropic model the call names. */
  readonly model: string;
  /**
   * False when no key is set. Generation then has nowhere to go: the work queues and says so,
   * and no local model stands in for it. Cue extraction is the one role with a non-generation
   * answer, and it takes the raw-query path the degradation ladder already has.
   */
  readonly available: boolean;
};

export type ProviderRouting = {
  readonly roles: Readonly<Record<GenerationRole, RoleRoute>>;
  readonly keyPresent: boolean;
  /** Never routed: one model owns the vector space for the life of the substrate. */
  readonly embedModel: string;
};

/**
 * The whole routing rule, in one pure function of config: every generation role runs on the
 * configured Anthropic model, and embeddings are not part of the question. A missing key does
 * not reroute anything. It makes generation unavailable, which the queue reports as lag.
 */
export function resolveProviderRouting(config: Config): ProviderRouting {
  const keyPresent = config.anthropic.apiKey.trim().length > 0;
  const route = (role: GenerationRole): RoleRoute => {
    return { role, model: config.anthropic.model, available: keyPresent };
  };
  return {
    roles: { cue: route('cue'), reflect: route('reflect') },
    keyPresent,
    embedModel: config.models.embed,
  };
}

function routeList(routing: ProviderRouting): readonly RoleRoute[] {
  return GENERATION_ROLES.map((role) => routing.roles[role]);
}

/**
 * One line for a log or a status row: `cue=anthropic:claude-haiku-4-5 reflect=...`, or
 * `cue=queued reflect=queued` with no key, which is what the substrate is actually doing.
 */
export function routingSummary(routing: ProviderRouting): string {
  return routeList(routing)
    .map((route) => `${route.role}=${route.available ? `anthropic:${route.model}` : 'queued'}`)
    .join(' ');
}

/**
 * What `aion status` prints about generation: which call classes leave the machine, named as
 * call classes rather than as role names, and what does not. With no key it prints the other
 * half of the same fact, since an operator whose reflection backlog is not draining needs to
 * read the reason here rather than infer it from the queue depth.
 */
export function remoteBannerLines(routing: ProviderRouting): readonly string[] {
  const routes = routeList(routing);
  if (!routing.keyPresent) {
    return [
      'remote   no AION_ANTHROPIC_API_KEY is set, so generation has nowhere to run:',
      ...routes.map((route) => `           ${ROLE_CALL_CLASS[route.role]}`),
      '         capture, embeddings and every graph read still work. Generation work queues',
      '         until a key is set, and recall falls back to the raw query text.',
    ];
  }
  const models = [...new Set(routes.map((route) => route.model))].join(', ');
  return [
    `remote   generation leaves this machine for the Anthropic API (${models}):`,
    ...routes.map((route) => `           ${ROLE_CALL_CLASS[route.role]}`),
    '         embeddings and every graph read stay local.',
  ];
}
