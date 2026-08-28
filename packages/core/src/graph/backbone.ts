import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import { writeStampedNode, type StampedNodeResult } from './bitemporal.js';
import { runRead } from './connection.js';

/** PRD §5.3: the workspace is a fixed singleton, not a user-supplied name. */
export const GLOBAL_WORKSPACE_NAME = 'global';

const MEMBER_ENTITY_TYPE = 'member';
const WORKSPACE_ENTITY_TYPE = 'workspace';

export type BootstrapBackboneInput = {
  readonly memberName: string;
  readonly now?: Date;
};

export type BootstrapBackboneResult = {
  readonly member: StampedNodeResult;
  readonly workspace: StampedNodeResult;
};

function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Member and Workspace are true singletons: at most one of each will ever exist.
 * `writeStampedNode` merges on (label, id), so a fresh `randomUUID()` every call would
 * create a second node instead of finding the first; resolving the id by the same
 * `name_norm` the `entity_name_type_unique` constraint keys on is what makes a repeat
 * bootstrap land on the existing node.
 */
async function resolveSingletonId(
  driver: Driver,
  label: 'Member' | 'Workspace',
  nameNorm: string,
): Promise<string | undefined> {
  const rows = await runRead(
    driver,
    `MATCH (n:${label} { name_norm: $nameNorm }) RETURN n.id AS id`,
    { nameNorm },
    (row) => row.id as string,
  );
  return rows[0];
}

/** Whitepaper §4.2 / PRD §5.3: the single-user shadow of the structural backbone, created at init. */
export async function bootstrapBackbone(
  driver: Driver,
  input: BootstrapBackboneInput,
): Promise<BootstrapBackboneResult> {
  const now = input.now ?? new Date();

  const memberNameNorm = normalizeEntityName(input.memberName);
  const memberId = (await resolveSingletonId(driver, 'Member', memberNameNorm)) ?? randomUUID();
  const member = await writeStampedNode(driver, {
    label: 'Member',
    id: memberId,
    now,
    properties: { name: input.memberName, name_norm: memberNameNorm, type: MEMBER_ENTITY_TYPE },
    mergeProperties: { is_structural: true },
  });

  const workspaceNameNorm = normalizeEntityName(GLOBAL_WORKSPACE_NAME);
  const workspaceId = (await resolveSingletonId(driver, 'Workspace', workspaceNameNorm)) ?? randomUUID();
  const workspace = await writeStampedNode(driver, {
    label: 'Workspace',
    id: workspaceId,
    now,
    properties: { name: GLOBAL_WORKSPACE_NAME, name_norm: workspaceNameNorm, type: WORKSPACE_ENTITY_TYPE },
    mergeProperties: { is_structural: true },
  });

  return { member, workspace };
}
