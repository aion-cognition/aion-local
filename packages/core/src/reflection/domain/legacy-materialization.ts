import {
  durableRoleScope,
  type DurableRole,
  type ScopeDirection,
} from '../../evidence/domain/scopes.js';
import type { LegacyRelation } from '../../infrastructure/graph/legacy-evidence-queries.js';
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
  CORRECTS: {
    start: {
      record: 'stated',
      kind: 'corrects',
      role: 'stated_correction',
      otherNotLabels: RAW_LABELS,
    },
  },
  EVIDENCES: {
    start: {
      record: 'stated',
      kind: 'confirms',
      role: 'stated_confirmation',
      otherNotLabels: RAW_LABELS,
    },
  },
  DERIVES_FROM: {
    start: {
      record: 'stated',
      kind: 'derived_from',
      role: 'stated_derivation',
      otherNotLabels: RAW_LABELS,
    },
  },
};

/** Whether the other endpoint is what the rule says it must be. */
function endpointMatches(rule: RelationRule, otherLabels: readonly string[]): boolean {
  if (rule.otherLabel !== undefined && !otherLabels.includes(rule.otherLabel)) {
    return false;
  }
  return (rule.otherNotLabels ?? []).every((label) => !otherLabels.includes(label));
}

/** A relationship whose two ends are both this source's own raw nodes: its internal order. */
const INTERNAL_ROLE: DurableRole = 'raw_order';

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
  qualifier: 'part' | 'retained_node',
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
  for (const relation of input.relations) {
    const fromRaw = raw.has(relation.fromId);
    const toRaw = raw.has(relation.toId);
    if (fromRaw && toRaw) {
      // The source's own shape. The link names the member end, so an episode's turns stay
      // addressable through the same records as everything else it carries.
      const memberId = relation.fromId === input.sourceId ? relation.toId : relation.fromId;
      const internal = link(
        input.sourceId,
        relation,
        { record: 'incidence', role: INTERNAL_ROLE },
        memberId,
        'part',
      );
      links.set(internal.linkId, internal);
      continue;
    }
    const side: RawSide = fromRaw ? 'start' : 'end';
    const otherId = fromRaw ? relation.toId : relation.fromId;
    const otherLabels = fromRaw ? relation.toLabels : relation.fromLabels;
    const rule = RULES[relation.type]?.[side];
    if (rule === undefined || !endpointMatches(rule, otherLabels)) {
      pins.push({
        relationId: relation.relationId,
        relationType: relation.type,
        reason: `no classification for ${relation.type} with the source at the ${side} and the other end labelled ${otherLabels.join('+')}`,
      });
      continue;
    }
    const classified = link(input.sourceId, relation, rule, otherId, 'retained_node');
    links.set(classified.linkId, classified);
  }
  return {
    links: [...links.values()].sort((a, b) => (a.linkId < b.linkId ? -1 : 1)),
    pins,
  };
}

/**
 * The direction each role's scope carries at the NODE end, and therefore the opposite at the
 * source end.
 *
 * The link is always stored source-to-node, because that is what an incidence row is. The scope
 * direction is a separate question and the registry already answers it: a claim's own extraction
 * is `extraction:out` on the claim (`subjects.ts` reads it there, `OWNERSHIP_SCOPES` registers it
 * there), because the claim is the end that asserts it. Deriving the direction from how the link
 * happens to be stored would key a claim's extraction under `extraction:in`, which is a counter
 * nothing else reads and a census nothing else can see.
 */
const NODE_DIRECTION: Readonly<Record<DurableRole, ScopeDirection>> = {
  extraction: 'out',
  mention: 'in',
  participation: 'in',
  source_coverage: 'in',
  session_ownership: 'in',
  raw_order: 'in',
  stated_confirmation: 'in',
  stated_correction: 'in',
  stated_derivation: 'in',
};

export function nodeScopeDirection(role: DurableRole): ScopeDirection {
  return NODE_DIRECTION[role];
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
    const node = NODE_DIRECTION[entry.scopeRole];
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

/** The retained endpoints a plan records incidence against, which is what ownership is projected for. */
export function planNodes(links: readonly MaterializedLink[]): readonly string[] {
  return [...new Set(links.filter((entry) => entry.incident).map((entry) => entry.toId))].sort();
}
