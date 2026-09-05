import type { Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';

import {
  BITEMPORAL_PROPERTIES,
  writeStampedNodeInTransaction,
  type StampedNodeResult,
} from './bitemporal.js';
import { inWriteTransaction, runRead, type GraphTransaction } from './connection.js';
import { upsertEdgeInTransaction } from './edges.js';
import { foldName } from '../../reflection/domain/name-fold.js';

/** The workspace is a fixed singleton, not a user-supplied name. */
export const GLOBAL_WORKSPACE_NAME = 'global';

/**
 * The substrate answers to one name, the same on every install. It is a constant rather than a
 * knob because the node is the substrate's own identity: a renamed substrate would be a second
 * identity for the same memory.
 */
export const SUBSTRATE_NAME = 'Aion';

const MEMBER_ENTITY_TYPE = 'member';
const WORKSPACE_ENTITY_TYPE = 'workspace';
const SUBSTRATE_ENTITY_TYPE = 'substrate';

/** The substrate's link to the global workspace: written once, never reinforced by observation. */
const STRUCTURAL_SIGNALS = ['structural'];
const STRUCTURAL_PROVENANCE = ['backbone'];

export type BootstrapBackboneInput = {
  readonly memberName: string;
  readonly now?: Date;
};

export type BootstrapBackboneResult = {
  readonly member: StampedNodeResult;
  readonly workspace: StampedNodeResult;
  readonly substrate: StampedNodeResult;
};

/** Collapses whitespace and trims, keeping the case the user typed. */
function displayName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function normalizeEntityName(name: string): string {
  return foldName(name);
}

/**
 * The id one backbone singleton already answers to. `writeStampedNode` merges on
 * (label, id), so a fresh `randomUUID()` every call would create a second node instead of
 * finding the first. The label alone identifies the singleton: resolving by name would fork
 * the backbone the first time a name changes (a corrected git identity, a typo at the init
 * prompt), leaving prior sessions hanging off an orphaned Member. Earliest-stamped wins so
 * the choice is stable across runs.
 *
 * The read runs in the caller's write transaction, next to the write it feeds. The two
 * production callers are `aion init` and `aion replay`, single-process commands a person runs;
 * a substrate bootstrapped by two processes at once would still mint two ids here, because a
 * singleton keyed on a fresh UUID has no shared key for the two writes to serialize on.
 */
async function resolveSingletonIdInTransaction(
  tx: GraphTransaction,
  label: 'Member' | 'Workspace' | 'Substrate',
): Promise<string | undefined> {
  const rows = await tx.run(
    `MATCH (n:${label}) RETURN n.id AS id ORDER BY n.${BITEMPORAL_PROPERTIES.txFrom}, n.id LIMIT 1`,
    {},
    (row) => row.id as string,
  );
  return rows[0];
}

/**
 * The substrate's own identity node, undefined on a graph the backbone has never bootstrapped.
 * Read inside the caller's transaction, beside the write it decides.
 */
export async function readSubstrateIdInTransaction(
  tx: GraphTransaction,
): Promise<string | undefined> {
  return resolveSingletonIdInTransaction(tx, 'Substrate');
}

/**
 * The stored Member's display name, undefined before the backbone exists. `bootstrapBackbone`
 * merges the name it is given on every call, so a process that did not create the backbone
 * (the long-lived MCP service, which never prompts) reads the name back and passes it in
 * rather than renaming the Member to whatever its own environment happened to carry.
 */
export async function readMemberName(driver: Driver): Promise<string | undefined> {
  const rows = await runRead(
    driver,
    `MATCH (n:Member) RETURN n.name AS name ORDER BY n.${BITEMPORAL_PROPERTIES.txFrom}, n.id LIMIT 1`,
    {},
    (row) => row.name as string | null,
  );
  const name = rows[0];
  if (name === undefined || name === null || name === '') {
    return undefined;
  }
  return name;
}

/**
 * The single-user shadow of the structural backbone, created at init. A changed member
 * name renames the one node rather than superseding it: the Member is an identity that
 * every session edge points at, and its name is a label on that identity, not a fact about
 * the world that can be current or stale.
 */
export async function bootstrapBackbone(
  driver: Driver,
  input: BootstrapBackboneInput,
): Promise<BootstrapBackboneResult> {
  const now = input.now ?? new Date();

  const memberName = displayName(input.memberName);

  return inWriteTransaction(driver, async (tx) => {
    const memberId = (await resolveSingletonIdInTransaction(tx, 'Member')) ?? randomUUID();
    const member = await writeStampedNodeInTransaction(tx, {
      label: 'Member',
      id: memberId,
      now,
      properties: { type: MEMBER_ENTITY_TYPE },
      mergeProperties: {
        is_structural: true,
        name: memberName,
        name_norm: normalizeEntityName(memberName),
      },
    });

    const workspaceId = (await resolveSingletonIdInTransaction(tx, 'Workspace')) ?? randomUUID();
    const workspace = await writeStampedNodeInTransaction(tx, {
      label: 'Workspace',
      id: workspaceId,
      now,
      properties: { type: WORKSPACE_ENTITY_TYPE },
      mergeProperties: {
        is_structural: true,
        name: GLOBAL_WORKSPACE_NAME,
        name_norm: normalizeEntityName(GLOBAL_WORKSPACE_NAME),
      },
    });

    // The substrate's own identity, one node for the life of the substrate. It is deliberately
    // not an Agent: agents are the voices, harnesses, and models that connect, and a Claude
    // session and a Codex session here continue one identity because the memory is the
    // continuity. Which harness or model produced an episode is provenance the episode carries,
    // never a second identity node. Separate personas with separate memory would be
    // workspace-level tenancy, which this is not. Structural like the Member and the Workspace:
    // an address and an attachment point, dropped from packs and never reinforced.
    const substrateId = (await resolveSingletonIdInTransaction(tx, 'Substrate')) ?? randomUUID();
    const substrate = await writeStampedNodeInTransaction(tx, {
      label: 'Substrate',
      id: substrateId,
      now,
      properties: { type: SUBSTRATE_ENTITY_TYPE },
      mergeProperties: {
        is_structural: true,
        name: SUBSTRATE_NAME,
        name_norm: normalizeEntityName(SUBSTRATE_NAME),
      },
    });

    // Upserted with `count: 0` so a rerun is a no-op, the shape every structural edge takes.
    await upsertEdgeInTransaction(tx, {
      type: 'WITHIN_WORKSPACE',
      sourceId: substrate.id,
      targetId: workspace.id,
      strength: 1,
      confidence: 1,
      signals: STRUCTURAL_SIGNALS,
      provenance: STRUCTURAL_PROVENANCE,
      count: 0,
      now,
    });

    return { member, workspace, substrate };
  });
}
