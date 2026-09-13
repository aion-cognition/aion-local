import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  acknowledgeEvidenceRecords,
  derivedRelationId,
  discardEvidenceRecords,
  prepareEvidenceRecords,
  type EvidenceLinkRecord,
  type ScopeAdvanceKey,
} from './evidence-records.js';
import {
  acknowledgeMintedNodeState,
  discardMintedNodeState,
  nodeStateScope,
  prepareMintedNodeState,
} from '../../evidence/application/node-state.js';
import { NODE_SUPPORT_ROLE_SCOPES } from '../../evidence/application/node-support.js';
import { bothEndpoints, GRAPH_NODE_SCOPE } from '../../evidence/domain/scopes.js';
import type { PublicationCoordinator } from '../../infrastructure/publication/coordinator.js';
import { PublicationOperation } from '../../infrastructure/publication/operation.js';
import { buildEvidenceRevision } from '../../infrastructure/publication/preconditions.js';
import { readCurrentCoverageContract } from '../../infrastructure/sqlite/coverage-contract.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { evidenceLinkId } from '../../infrastructure/sqlite/evidence-links.js';
import { readScopeVersion } from '../../infrastructure/sqlite/evidence-scope.js';

/**
 * The evidence a node derived from a capture is born with.
 *
 * An extraction and a mention are relationships a stage made, and the durable record of one is
 * what lets a later reader say which source stands behind the node. Without it a judge asked about
 * the node reads an uncounted population, cannot name a single source, and abstains on every real
 * pair. The stage that wrote the graph is the only caller that can say what it wrote, so it is the
 * one that records it.
 *
 * A MINTED node is counted from birth, and that is the whole reason this is a separate claim from
 * the relationship itself. The id was drawn by the write that created the node, so nothing else has
 * ever recorded anything about it: every population a reader asks after is empty except the one
 * this write is recording, which makes the census a statement about what is there rather than a
 * guess about what might be. A node this operation did not mint keeps whatever census it has; its
 * own creating write made that claim and this one only moves the counters.
 *
 * `minted` is the writer's claim about an id of its own, never something this operation infers
 * about a node it was handed. A writer answers it from the graph write it just made, or, where
 * that write reports an id it drew on an earlier attempt, from `owesBirthEstablishment` below. A
 * node some other run created keeps whatever census that run established, and re-claiming it here
 * would count a population this write never looked at.
 */
export const DERIVED_NODE_EFFECTS = {
  records: 'derived_node_evidence_records',
} as const;

/** The roles a derived node is born in. Each is a source standing behind the node it names. */
export const DERIVED_NODE_ROLES = ['extraction', 'mention', 'participation'] as const;

export type DerivedNodeRole = (typeof DERIVED_NODE_ROLES)[number];

const Node = z.strictObject({
  nodeId: z.string().min(1),
  /** The capture this relationship runs from. A node derived from several names each of them. */
  sourceId: z.string().min(1),
  role: z.enum(DERIVED_NODE_ROLES),
  /** The graph relationship this record stands for, so a rebuild produces the same link. */
  relationType: z.string().min(1),
  relationId: z.string().min(1),
  /** Whether the graph write that recorded this relationship also drew the node's id. */
  minted: z.boolean(),
});

const Payload = z.strictObject({
  /** What this write was about, for the receipt. The links name their own sources. */
  subject: z.string().min(1),
  observedAt: z.string().min(1),
  nodes: z.array(Node).min(1),
});

const Result = z.strictObject({
  recorded: z.number().int().nonnegative(),
  preserved: z.number().int().nonnegative(),
  established: z.number().int().nonnegative(),
});

type DerivedNodeData = z.infer<typeof Payload>;
type DerivedNode = z.infer<typeof Node>;

function linkOf(data: DerivedNodeData, node: DerivedNode): EvidenceLinkRecord {
  return {
    linkId: evidenceLinkId(node.role, 'retained_node', node.sourceId, node.nodeId),
    kind: node.role,
    qualifier: 'retained_node',
    fromId: node.sourceId,
    toId: node.nodeId,
    relationId: node.relationId,
    relationType: node.relationType,
    incident: true,
    closed: false,
    clocks: { tx_from: data.observedAt },
    recorded: {},
  };
}

function links(data: DerivedNodeData): readonly EvidenceLinkRecord[] {
  return data.nodes.map((node) => linkOf(data, node));
}

/**
 * Every counter this operation touches, each named once.
 *
 * A minted node carries the whole support set rather than the one role this write recorded. The
 * reader that decides whether a node still holds anything up asks all seven, and a census
 * established on one of them leaves the answer unknown while looking counted. All seven are honest
 * here for the same reason the one is: the id is this write's own.
 *
 * The node's state counter is not in this list. It is a graph-authority scope and takes a mirror
 * beside its census, so it is prepared and acknowledged through its own pair of calls.
 */
function scopesOf(data: DerivedNodeData): readonly ScopeAdvanceKey[] {
  const scopes = new Map<string, ScopeAdvanceKey>();
  const put = (entry: ScopeAdvanceKey): void => {
    const key = `${entry.endpointId}\n${entry.relationClass}`;
    // A basis, once claimed for a counter, stands: two entries for one counter in one operation
    // differ only in whether the minting claim reached it first.
    if (scopes.get(key)?.censusBasis === undefined) {
      scopes.set(key, entry);
    }
  };
  for (const node of data.nodes) {
    for (const entry of bothEndpoints(node.role, node.sourceId, node.nodeId)) {
      put(entry);
    }
    if (!node.minted) {
      continue;
    }
    for (const relationClass of NODE_SUPPORT_ROLE_SCOPES) {
      put({ endpointId: node.nodeId, relationClass, censusBasis: 'minted_identity' });
    }
  }
  return [...scopes.values()];
}

function mintedNodes(data: DerivedNodeData): readonly string[] {
  return [...new Set(data.nodes.filter((node) => node.minted).map((node) => node.nodeId))];
}

export const derivedNodeEvidencePublication = new PublicationOperation({
  kind: 'derived_node_evidence',
  effectKinds: [DERIVED_NODE_EFFECTS.records],
  payload: Payload,
  data: Payload,
  result: Result,
  prepare(context, payload) {
    const coverage = readCurrentCoverageContract(context.db);
    if (coverage === undefined) {
      throw new Error('derived node evidence cannot publish before the coverage registry exists');
    }
    return Promise.resolve({
      data: payload,
      expected: {
        coverageEpoch: coverage.epoch,
        evidence: buildEvidenceRevision([]),
        sources: [],
        heads: [],
      },
      scopes: [
        ...scopesOf(payload).map((scope) => ({
          kind: 'relation_scope' as const,
          id: scope.endpointId,
          scope: scope.relationClass,
        })),
        ...mintedNodes(payload).map((nodeId) => ({
          kind: 'relation_scope' as const,
          id: nodeId,
          scope: nodeStateScope(nodeId).relationClass,
        })),
      ],
      effects: [{ kind: DERIVED_NODE_EFFECTS.records, detail: { nodes: payload.nodes.length } }],
    });
  },
  check() {
    // The relationships are already in the graph. What is refused here is nothing: a record of a
    // write that happened is owed whatever else has moved, and withholding it is what leaves a
    // node with no source behind it for good.
    return Promise.resolve({ status: 'valid' } as const);
  },
  applyGraph(_context, data) {
    // Nothing is written to the graph. The stage that made the relationships wrote them, and this
    // operation records what it made, under the guard so the counters it moves are fenced.
    return Promise.resolve({
      recorded: data.nodes.length,
      preserved: 0,
      established: mintedNodes(data).length,
    });
  },
  prepareSqlite(context, data) {
    prepareEvidenceRecords(context.db, {
      sourceId: data.subject,
      operationId: context.operationId,
      links: links(data),
      scopes: scopesOf(data),
      observedAt: new Date(data.observedAt),
    });
    for (const nodeId of mintedNodes(data)) {
      prepareMintedNodeState(context.db, nodeId, context.operationId, new Date(data.observedAt));
    }
    return undefined;
  },
  acknowledgeSqlite(context, data) {
    acknowledgeEvidenceRecords(
      context.db,
      {
        sourceId: data.subject,
        operationId: context.operationId,
        links: links(data),
        scopes: scopesOf(data),
        observedAt: new Date(data.observedAt),
      },
      context.knownFrom,
      context.observedAckAt,
    );
    for (const nodeId of mintedNodes(data)) {
      acknowledgeMintedNodeState(context.db, nodeId, context.operationId, context.knownFrom);
    }
    return undefined;
  },
  discardSqlite(context, data) {
    discardEvidenceRecords(context.db, {
      sourceId: data.subject,
      operationId: context.operationId,
      scopes: scopesOf(data),
      observedAt: new Date(data.observedAt),
    });
    for (const nodeId of mintedNodes(data)) {
      discardMintedNodeState(context.db, nodeId, context.operationId, new Date(data.observedAt));
    }
    return undefined;
  },
});

/**
 * What a stage hands the publication for one node it just wrote.
 *
 * The relation id defaults to the identity the type and the endpoints fix, which is what a writer
 * that upserted an edge without reading back its id still knows about it.
 */
export function derivedNode(input: {
  readonly nodeId: string;
  readonly role: DerivedNodeRole;
  readonly relationType: string;
  readonly sourceId: string;
  readonly minted: boolean;
  readonly relationId?: string;
}): DerivedNode {
  return {
    nodeId: input.nodeId,
    sourceId: input.sourceId,
    role: input.role,
    relationType: input.relationType,
    relationId:
      input.relationId ?? derivedRelationId(input.relationType, input.sourceId, input.nodeId),
    minted: input.minted,
  };
}

export type { DerivedNode };

/**
 * Whether the records still owe a node the census its birth entitles it to.
 *
 * A stage writes the graph and then hands the evidence to a publication, and that handoff can
 * fail: the relationships are durable, the record of them is not, and the retry reads `created:
 * false` from a graph that is already right. The obligation survives it, because it rests on
 * whether the birth censuses were actually established, not on whether some counter has since
 * published. A later episode can mention the same entity and advance those counters honestly
 * without ever establishing them, and the creator's retry still owes the census that mention
 * did not make.
 *
 * The scopes checked are `NODE_SUPPORT_ROLE_SCOPES` plus `GRAPH_NODE_SCOPE`, the birth role set
 * a node is minted under, not the broader set a reader asks that also carries the citation scope:
 * nothing about a node's birth ever establishes a census over citations to it, so requiring one
 * here would leave every fresh node owing a count nothing at birth writes. A scope with no row
 * yet, or one that has advanced without ever being established, still owes; only a census
 * established on every one of them closes the obligation.
 *
 * The caller owes the other half and this function cannot check it. An uncounted id is no
 * evidence about who drew it, so only a writer whose own identity fixes the id may ask: the
 * cognitive stage folds it from the source episode, an entity node records the episode that
 * created it, and a consolidation folds it from its own member set. A caller that asked about an
 * arbitrary node would claim a census over a population it never looked at.
 */
export function owesBirthEstablishment(db: SqliteHandle, nodeId: string): boolean {
  return [...NODE_SUPPORT_ROLE_SCOPES, GRAPH_NODE_SCOPE].some(
    (relationClass) =>
      readScopeVersion(db, { endpointId: nodeId, relationClass })?.censusStatus !== 'established',
  );
}

export type DerivedNodeEvidenceOutcome =
  | { readonly status: 'published'; readonly operationId: string; readonly established: number }
  | { readonly status: 'refused'; readonly reason: string };

/**
 * Records what one stage's writes produced, in the run that produced them.
 *
 * A refusal is named and returned rather than thrown. The stage has already written the graph, so
 * the nodes exist either way; what a refusal costs is the record of their sources, and the stage
 * reports that as its own failure rather than as a run that lost the nodes.
 */
export async function publishDerivedNodeEvidence(
  deps: {
    /**
     * The publish surface alone, not the coordinator. A stage's own unit tests hold a fake graph
     * and no substrate, so a stub that records the request is what lets them assert the stage
     * reported every node it wrote; the type says the function needs nothing more than that.
     */
    readonly publications: Pick<PublicationCoordinator, 'publish'>;
    readonly now: Date;
  },
  input: { readonly subject: string; readonly nodes: readonly DerivedNode[] },
): Promise<DerivedNodeEvidenceOutcome> {
  if (input.nodes.length === 0) {
    return { status: 'refused', reason: 'no_node_recorded' };
  }
  const operationId = randomUUID();
  const outcome = await deps.publications.publish({
    kind: derivedNodeEvidencePublication.kind,
    operationId,
    payload: {
      subject: input.subject,
      observedAt: deps.now.toISOString(),
      nodes: input.nodes,
    },
  });
  if (outcome.status !== 'acknowledged') {
    return { status: 'refused', reason: outcome.reason };
  }
  return {
    status: 'published',
    operationId,
    established: derivedNodeEvidencePublication.decodeResult(outcome.result).established,
  };
}
