import {
  durableRoleScope,
  nodeScopeDirection,
  type DurableRole,
  type ScopeDirection,
} from '../../evidence/domain/scopes.js';
import type {
  EndpointContribution,
  LegacyRelation,
} from '../../infrastructure/graph/legacy-evidence-queries.js';
import { evidenceLinkId, type StatedLinkKind } from '../../infrastructure/sqlite/evidence-links.js';

/**
 * What a legacy graph edge means in the durable records, decided once and by a closed table.
 *
 * A legacy source's only record of a mention, an extraction or a correction is the edge in the
 * graph, so the migration has to say what each edge stands for before it can record anything.
 * The table below is the whole vocabulary. A type this file does not name, or a named type
 * pointing the wrong way, PINS the source: it is a relationship somebody wrote deliberately and
 * nobody here can classify, and guessing at it would put an invented role into the one record a
 * later reader resolves history against.
 *
 * Nothing here credits an observation, a confirmation or a salience count. A backfill records
 * that a relationship existed; it did not witness one.
 */

/** The graph's own containment edge, used for turn ordering, participation and session ownership alike. */
const CONTAINMENT = 'PARTICIPATES_IN';

/** Which end of the edge the source's own raw node sits on. */
export type RawSide = 'start' | 'end';

export type IncidenceRule = {
  readonly record: 'incidence';
  readonly role: DurableRole;
};

export type StatedRule = {
  readonly record: 'stated';
  readonly kind: StatedLinkKind;
  readonly role: DurableRole;
};

export type RelationRule = (IncidenceRule | StatedRule) & {
  /** The label the other endpoint must carry, where the type alone does not fix what it is. */
  readonly otherLabel?: string;
  /** Labels the other endpoint may not carry: a raw node belonging to some other source. */
  readonly otherNotLabels?: readonly string[];
};

/** The raw node types. An edge reaching one of these outside this source's own set crosses families. */
const RAW_LABELS = ['Episode', 'Turn'] as const;

/**
 * The classification table. Keyed on the relationship type and the end the raw node sits on,
 * because the same type means different things in the two directions: an entity participating
 * in an episode and an episode participating in a session are both `PARTICIPATES_IN`.
 *
 * `FOLLOWS` is deliberately absent. Turn order is internal to one source, so it is classified by
 * the both-ends-raw branch below; a `FOLLOWS` crossing source families is unexpected in v1 and
 * pins rather than pulling a stranger's turn into these records.
 */
const RULES: Readonly<Record<string, Partial<Record<RawSide, RelationRule>>>> = {
  MENTIONS: {
    start: { record: 'incidence', role: 'mention', otherNotLabels: RAW_LABELS },
  },
  EXTRACTED_FROM: {
    end: { record: 'incidence', role: 'extraction', otherNotLabels: RAW_LABELS },
  },
  SUMMARIZED_BY: {
    start: { record: 'incidence', role: 'source_coverage', otherLabel: 'Narrative' },
  },
  [CONTAINMENT]: {
    start: { record: 'incidence', role: 'session_ownership', otherLabel: 'Session' },
    end: { record: 'incidence', role: 'participation', otherNotLabels: RAW_LABELS },
  },
  // A statement may name another source or one of its parts. That is what the signed target
  // taxonomy provides `source` and `part` qualifiers for, so the endpoint is classified rather
  // than excluded: refusing every raw target would pin a correction the vocabulary describes.
  CORRECTS: {
    start: { record: 'stated', kind: 'corrects', role: 'stated_correction' },
  },
  EVIDENCES: {
    start: { record: 'stated', kind: 'confirms', role: 'stated_confirmation' },
  },
  DERIVES_FROM: {
    start: { record: 'stated', kind: 'derived_from', role: 'stated_derivation' },
  },
};

/**
 * The only relationship types that mean "this is the source's own internal order".
 *
 * Membership of the raw set is not a classification. An unknown type between two owned nodes is
 * a relationship somebody wrote deliberately, and reading it as disposable ordering would erase
 * whatever it actually said.
 */
const INTERNAL_TYPES: readonly string[] = [CONTAINMENT, 'FOLLOWS'];

/**
 * What the target is, from the labels it carries. The qualifier disambiguates a pair of endpoints
 * two categories could share, and it is drawn from the signed closed set.
 */
function qualifierOf(labels: readonly string[]): 'source' | 'part' | 'retained_node' {
  if (labels.includes('Episode')) {
    return 'source';
  }
  return labels.includes('Turn') ? 'part' : 'retained_node';
}

/** Whether the other endpoint is what the rule says it must be. */
function endpointMatches(rule: RelationRule, otherLabels: readonly string[]): boolean {
  if (rule.otherLabel !== undefined && !otherLabels.includes(rule.otherLabel)) {
    return false;
  }
  return (rule.otherNotLabels ?? []).every((label) => !otherLabels.includes(label));
}

/** A relationship whose two ends are both this source's own raw nodes: its internal order. */
const INTERNAL_ROLE: DurableRole = 'raw_order';

/** Whether these labels are a source's own raw node rather than a retained interpretation. */
function isRawNode(labels: readonly string[]): boolean {
  return RAW_LABELS.some((label) => labels.includes(label));
}

export type MaterializedLink = {
  readonly linkId: string;
  /** The link's recorded classification, which the incidence role must equal. */
  readonly kind: string;
  readonly qualifier: string;
  readonly fromId: string;
  readonly toId: string;
  readonly relationId: string;
  readonly relationType: string;
  /** The durable role whose scope both endpoints advance. */
  readonly scopeRole: DurableRole;
  /** True for a link whose current projection is an incidence row. */
  readonly incident: boolean;
  readonly closed: boolean;
  readonly clocks: Readonly<Record<string, string>>;
  /** What the relationship itself said, carried across without becoming a new observation. */
  readonly recorded: Readonly<Record<string, string>>;
};

export type LegacyPin = {
  readonly relationId: string;
  readonly relationType: string;
  readonly reason: string;
};

export type MaterializationPlan = {
  readonly links: readonly MaterializedLink[];
  /** Relationships nobody could classify. One of these pins the whole source. */
  readonly pins: readonly LegacyPin[];
};

export type ScopeAdvanceKey = {
  readonly endpointId: string;
  readonly relationClass: string;
};

function clocksOf(relation: LegacyRelation): Readonly<Record<string, string>> {
  return {
    ...(relation.validFrom === undefined ? {} : { valid_from: relation.validFrom }),
    ...(relation.validUntil === undefined ? {} : { valid_until: relation.validUntil }),
    ...(relation.txFrom === undefined ? {} : { tx_from: relation.txFrom }),
    ...(relation.txUntil === undefined ? {} : { tx_until: relation.txUntil }),
    ...(relation.updatedAt === undefined ? {} : { updated_at: relation.updatedAt }),
  };
}

/** Closed in world time or in system time. Either bound retires the relationship. */
function isClosed(relation: LegacyRelation): boolean {
  return relation.validUntil !== undefined || relation.txUntil !== undefined;
}

function link(
  sourceId: string,
  relation: LegacyRelation,
  rule: RelationRule,
  otherId: string,
  qualifier: 'source' | 'part' | 'retained_node',
): MaterializedLink {
  const kind = rule.record === 'stated' ? rule.kind : rule.role;
  return {
    linkId: evidenceLinkId(kind, qualifier, sourceId, otherId),
    kind,
    qualifier,
    fromId: sourceId,
    toId: otherId,
    relationId: relation.relationId,
    relationType: relation.type,
    scopeRole: rule.role,
    incident: rule.record === 'incidence',
    closed: isClosed(relation),
    clocks: clocksOf(relation),
    recorded: relation.recorded ?? {},
  };
}

/**
 * What one source's enumerated relationships become.
 *
 * The source's own raw nodes are its episode and its turns. An edge between two of them is the
 * source's internal order and is recorded against the turn it names; an edge to anything else is
 * classified by the table. An edge whose other end is a raw node of some OTHER source is a
 * crossing this vocabulary does not describe, so it pins rather than dragging a stranger's turn
 * into this source's records.
 */
export function classifyLegacyRelations(input: {
  readonly sourceId: string;
  readonly rawIds: readonly string[];
  readonly relations: readonly LegacyRelation[];
}): MaterializationPlan {
  const raw = new Set(input.rawIds);
  const links = new Map<string, MaterializedLink>();
  const pins: LegacyPin[] = [];
  const pin = (relation: LegacyRelation, reason: string): void => {
    pins.push({ relationId: relation.relationId, relationType: relation.type, reason });
  };
  /**
   * One logical link, one original relationship. Two relationships that normalize onto the same
   * link are an unrepresentable collision: keeping the last witness would silently drop the
   * other's identity and clocks, so the source pins and nobody guesses which one it was.
   */
  const record = (relation: LegacyRelation, entry: MaterializedLink): void => {
    const held = links.get(entry.linkId);
    if (held !== undefined && held.relationId !== entry.relationId) {
      pin(
        relation,
        `relationship ${entry.relationId} and ${held.relationId} both normalize onto link ${entry.linkId}`,
      );
      return;
    }
    links.set(entry.linkId, entry);
  };
  for (const relation of input.relations) {
    const fromRaw = raw.has(relation.fromId);
    const toRaw = raw.has(relation.toId);
    if (fromRaw && toRaw) {
      // The source's own shape, and only for the types that mean one. The link names the member
      // end, so an episode's turns stay addressable through the same records as everything else.
      if (!INTERNAL_TYPES.includes(relation.type)) {
        pin(relation, `${relation.type} between two of the source's own raw nodes is not ordering`);
        continue;
      }
      const memberId = relation.fromId === input.sourceId ? relation.toId : relation.fromId;
      const memberLabels = relation.fromId === memberId ? relation.fromLabels : relation.toLabels;
      record(
        relation,
        link(
          input.sourceId,
          relation,
          { record: 'incidence', role: INTERNAL_ROLE },
          memberId,
          qualifierOf(memberLabels),
        ),
      );
      continue;
    }
    const side: RawSide = fromRaw ? 'start' : 'end';
    const otherId = fromRaw ? relation.toId : relation.fromId;
    const otherLabels = fromRaw ? relation.toLabels : relation.fromLabels;
    const rule = RULES[relation.type]?.[side];
    if (rule === undefined || !endpointMatches(rule, otherLabels)) {
      pin(
        relation,
        `no classification for ${relation.type} with the source at the ${side} and the other end labelled ${otherLabels.join('+')}`,
      );
      continue;
    }
    record(relation, link(input.sourceId, relation, rule, otherId, qualifierOf(otherLabels)));
  }
  return {
    links: [...links.values()].sort((a, b) => (a.linkId < b.linkId ? -1 : 1)),
    pins,
  };
}

/**
 * Every scope one plan moves: both ends of each role it recorded. Both ends, because a reader
 * asking the node what stands behind it and a reader asking the source what it touches are
 * reading two different counters.
 */
export function planScopes(
  sourceId: string,
  links: readonly MaterializedLink[],
): readonly ScopeAdvanceKey[] {
  const scopes = new Map<string, ScopeAdvanceKey>();
  for (const entry of links) {
    const node = nodeScopeDirection(entry.scopeRole);
    const source: ScopeDirection = node === 'in' ? 'out' : 'in';
    for (const scope of [
      { endpointId: sourceId, relationClass: durableRoleScope(entry.scopeRole, source) },
      { endpointId: entry.toId, relationClass: durableRoleScope(entry.scopeRole, node) },
    ]) {
      scopes.set(`${scope.endpointId}\n${scope.relationClass}`, scope);
    }
  }
  return [...scopes.values()].sort((a, b) =>
    `${a.endpointId}\n${a.relationClass}` < `${b.endpointId}\n${b.relationClass}` ? -1 : 1,
  );
}

/** The durable role each recorded link kind stands for, read off the classification table itself. */
function kindRoles(): ReadonlyMap<string, DurableRole> {
  const roles = new Map<string, DurableRole>([[INTERNAL_ROLE, INTERNAL_ROLE]]);
  for (const sides of Object.values(RULES)) {
    for (const rule of Object.values(sides)) {
      roles.set(rule.record === 'stated' ? rule.kind : rule.role, rule.role);
    }
  }
  return roles;
}

const KIND_ROLES = kindRoles();

/**
 * The role a stored link's kind names, or nothing for a kind this vocabulary never wrote.
 *
 * A stated link records the statement's own kind — `corrects` — while its scope is filed under the
 * role — `stated_correction`. Reading the scope off the kind string would file half the vocabulary
 * under counters nothing reads.
 */
export function roleOfLinkKind(kind: string): DurableRole | undefined {
  return KIND_ROLES.get(kind);
}

/** What one scope on an endpoint is a statement about. */
export type ScopePopulation = {
  /** The sources whose relationships land in this scope, sorted. */
  readonly sources: readonly string[];
  /** The link each of those relationships would have been recorded as. */
  readonly links: readonly string[];
  /**
   * False when some contributor's own source could not be named.
   *
   * A raw node belonging to no source still contributes a relationship somebody wrote. Nobody can
   * say whose it is, and a count that quietly leaves it out is a count with a hole in it — so the
   * uncertainty stays attached to the scope that relationship lands in, and that scope alone.
   */
  readonly attributed: boolean;
  /**
   * False when two different original relationships normalize onto one link.
   *
   * The records hold one version per logical link, so the second relationship has no
   * representation of its own: an older tuple would stand as proof that a later edge was recorded.
   * The materializer pins exactly this set rather than dropping an identity, and a scope holding
   * it is not a population anybody can prove either.
   */
  readonly represented: boolean;
};

/** Which sources stand behind each scope on one endpoint, and which nothing classified. */
export type EndpointPopulation = {
  readonly scopes: ReadonlyMap<string, ScopePopulation>;
  /** Relationships no rule classifies. They enter no counted population and pin their own source. */
  readonly unclassified: readonly LegacyPin[];
};

/** `links` holds the ORIGINAL relationship behind each link, which is what a collision is read off. */
type Collected = {
  sources: Set<string>;
  links: Map<string, string>;
  attributed: boolean;
  represented: boolean;
};

/** Which of the link's two scopes this endpoint sits at, or nothing when it is neither end. */
function endpointScopeOf(entry: MaterializedLink, endpointId: string): string | undefined {
  const node = nodeScopeDirection(entry.scopeRole);
  if (entry.toId === endpointId) {
    return durableRoleScope(entry.scopeRole, node);
  }
  const source: ScopeDirection = node === 'in' ? 'out' : 'in';
  return entry.fromId === endpointId ? durableRoleScope(entry.scopeRole, source) : undefined;
}

/**
 * What one endpoint's census is a statement about: every relationship the graph currently shows
 * landing in each of its scopes, with the source behind it and the link it would be recorded as.
 *
 * Each relationship is classified from ITS OWN source's side, by the same closed table the walk
 * used, so a census counts the population under exactly the rule that materialized it. The source
 * is whichever end owns one — the other end's, or the endpoint's own when the endpoint is a
 * source's raw node. Where neither end names a source and the contributor is a raw node, the
 * relationship is still classified, under the raw node standing for itself, so the scope it lands
 * in is known even though its attribution is not.
 *
 * An edge no rule names contributes to nothing at all: it is held by the pin on the source that
 * wrote it, not by a count filed under a role somebody guessed. An edge between two retained nodes
 * belongs to the graph's own relationship families and is not a source occurrence.
 */
export function endpointPopulation(input: {
  readonly endpointId: string;
  readonly contributions: readonly EndpointContribution[];
}): EndpointPopulation {
  const scopes = new Map<string, Collected>();
  const unclassified: LegacyPin[] = [];
  for (const row of input.contributions) {
    const owner = row.sourceId ?? row.endpointSourceId;
    const attributed = row.sourceId !== undefined || row.endpointSourceId !== undefined;
    // A raw node with no owner stands in for itself, which is enough to classify the edge and
    // therefore to know which scope the missing attribution belongs to.
    const sourceId = owner ?? (isRawNode(row.otherLabels) ? row.otherId : undefined);
    if (sourceId === undefined) {
      continue;
    }
    const relation: LegacyRelation = {
      relationId: row.relationId,
      type: row.type,
      fromId: row.endpointAtStart ? input.endpointId : row.otherId,
      toId: row.endpointAtStart ? row.otherId : input.endpointId,
      fromLabels: row.endpointAtStart ? row.endpointLabels : row.otherLabels,
      toLabels: row.endpointAtStart ? row.otherLabels : row.endpointLabels,
    };
    // The endpoint joins the source's raw set only when it is that source's own node. Adding it
    // unconditionally would read a correction pointing at another source's episode as this
    // source's internal ordering.
    const raw = new Set([sourceId, row.otherId]);
    if (row.endpointSourceId === sourceId) {
      raw.add(input.endpointId);
    }
    const plan = classifyLegacyRelations({ sourceId, rawIds: [...raw], relations: [relation] });
    unclassified.push(...plan.pins);
    for (const entry of plan.links) {
      const scope = endpointScopeOf(entry, input.endpointId);
      if (scope === undefined) {
        continue;
      }
      const held = scopes.get(scope) ?? {
        sources: new Set<string>(),
        links: new Map<string, string>(),
        attributed: true,
        represented: true,
      };
      if (attributed) {
        held.sources.add(sourceId);
        // Each relationship is classified on its own, so the batch rule that pins a collision
        // never sees the pair. The witness already filed under this link is what sees it here:
        // a second, different original relationship on the same link is one the records cannot
        // hold, and matching the link would certify a write that never named it.
        const witness = held.links.get(entry.linkId);
        if (witness !== undefined && witness !== entry.relationId) {
          held.represented = false;
        }
        held.links.set(entry.linkId, entry.relationId);
      } else {
        held.attributed = false;
      }
      scopes.set(scope, held);
    }
  }
  return {
    scopes: new Map(
      [...scopes].map(([scope, held]) => [
        scope,
        {
          sources: [...held.sources].sort(),
          links: [...held.links.keys()].sort(),
          attributed: held.attributed,
          represented: held.represented,
        },
      ]),
    ),
    unclassified,
  };
}

/** The retained endpoints a plan records incidence against, which is what ownership is projected for. */
export function planNodes(links: readonly MaterializedLink[]): readonly string[] {
  return [...new Set(links.filter((entry) => entry.incident).map((entry) => entry.toId))].sort();
}
