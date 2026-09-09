import type { ReflectionProvenance } from '@aion/protocol';
import { z } from 'zod';

import {
  acknowledgeReferenceAcceptance,
  classifyStatedReferences,
  discardReferenceAcceptance,
  prepareReferenceAcceptance,
  referenceScopeNames,
  statedReferenceIds,
  type ReferenceAcceptance,
  type StatedReferenceInput,
} from './reference-acceptance.js';
import {
  acknowledgedStatedReferenceVersion,
  statedReferenceKey,
  statedReferenceVersion,
} from './stated-references.js';
import type { GraphTransaction } from '../../infrastructure/graph/connection.js';
import { presentNodeIds } from '../../infrastructure/graph/projection-presence.js';
import type { EvidenceScope } from '../../infrastructure/publication/preconditions.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import {
  STATED_LINK_KINDS,
  STATED_LINK_QUALIFIERS,
} from '../../infrastructure/sqlite/evidence-links.js';
import { getExperienceByEpisode } from '../../infrastructure/sqlite/experience-archive.js';
import { markLedgerApplied } from '../../infrastructure/sqlite/ops-ledger.js';
import { readReferenceDelivery } from '../../infrastructure/sqlite/source-identity.js';

/**
 * The statements a legacy archive row carries in its own payload.
 *
 * An acceptance since the provenance split records statements as their own batch and leaves none
 * in the payload. A row written before it still carries them, and a walk over the graph cannot
 * find the ones whose edge was never written: the archive is the only witness that the caller
 * said them at all. This is what turns those into an accepted batch, under the same guard the
 * legacy producer holds for everything else it proves.
 *
 * The ledger marker is stamped in the acknowledgment and nowhere else. Comparing the payload's
 * digest proves the statements were READ, and a marker written on that alone tells every later
 * pass that work nobody did is finished.
 */

const Target = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(STATED_LINK_KINDS),
  targetClass: z.enum(STATED_LINK_QUALIFIERS),
  confirmation: z
    .strictObject({
      by: z.string(),
      evidence: z.string(),
      occurredAt: z.string().min(1),
      statedOccurredAt: z.string().min(1).optional(),
    })
    .optional(),
});

/** The plan block a producer carries in its intent, so a replay accepts what was decided. */
export const LegacyStatementsSchema = z.strictObject({
  /** The digest of the payload block, which is what the marker records once it lands. */
  version: z.string().min(1),
  targets: z.array(Target),
});

export type LegacyStatements = z.infer<typeof LegacyStatementsSchema>;

/** One pass of one source's archive statements, through one publication. */
export type LegacyStatementPass = {
  readonly sourceId: string;
  readonly operationId: string;
  readonly acceptedAt: string;
  /** Absent where the row states nothing, or states nothing the substrate has not accepted. */
  readonly statements: LegacyStatements | undefined;
};

function acceptanceOf(pass: LegacyStatementPass): ReferenceAcceptance | undefined {
  return pass.statements === undefined
    ? undefined
    : {
        sourceId: pass.sourceId,
        targets: pass.statements.targets,
        // One delivery per source and payload version, so a replay accepts the same batch once.
        deliveryKey: `legacy-archive:${pass.sourceId}:${pass.statements.version}`,
        operationId: pass.operationId,
        acceptedAt: pass.acceptedAt,
      };
}

/** The scopes an archive acceptance moves, declared beside the ones the walk found. */
export function legacyStatementScopes(
  sourceId: string,
  statements: LegacyStatements | undefined,
): readonly EvidenceScope[] {
  return statements === undefined
    ? []
    : referenceScopeNames({ sourceId, targets: statements.targets });
}

function statedInput(provenance: ReflectionProvenance): StatedReferenceInput {
  return {
    supersedes: provenance.supersedes ?? [],
    derivedFrom: provenance.derived_from ?? [],
    confirmations: (provenance.confirmations ?? []).map((entry) => ({
      target: entry.target,
      by: entry.by,
      evidence: entry.evidence,
      ...(entry.occurred_at === undefined ? {} : { occurredAt: entry.occurred_at }),
    })),
  };
}

/**
 * What the archive still owes for this source, or nothing.
 *
 * Nothing means one of two things and they are the same answer: the row carries no statements,
 * or the version it carries is already acknowledged. A row whose statements changed since the
 * last acknowledgment reads as owed again, because the version moved.
 */
export async function planLegacyStatements(
  graph: GraphTransaction,
  db: SqliteHandle,
  sourceId: string,
  acceptedAt: string,
): Promise<LegacyStatements | undefined> {
  const provenance = getExperienceByEpisode(db, sourceId)?.payload.provenance;
  if (provenance === undefined) {
    return undefined;
  }
  const version = statedReferenceVersion(provenance);
  if (version === acknowledgedStatedReferenceVersion(db, sourceId)) {
    return undefined;
  }
  const stated = statedInput(provenance);
  const retained = await presentNodeIds(graph, statedReferenceIds(stated));
  return { version, targets: classifyStatedReferences(db, stated, retained, acceptedAt) };
}

export function prepareLegacyStatements(db: SqliteHandle, pass: LegacyStatementPass): void {
  const acceptance = acceptanceOf(pass);
  if (acceptance !== undefined) {
    prepareReferenceAcceptance(db, acceptance);
  }
}

/**
 * The acknowledgment half: the batch joins the committed view and only then does the marker say
 * so. A throw here takes the whole acknowledgment and leaves the statements owed.
 */
export function acknowledgeLegacyStatements(
  db: SqliteHandle,
  pass: LegacyStatementPass,
  stamp: { readonly knownFrom: string; readonly observedAckAt: string },
): void {
  const acceptance = acceptanceOf(pass);
  if (acceptance === undefined || pass.statements === undefined) {
    return;
  }
  const delivery = readReferenceDelivery(db, acceptance.sourceId, acceptance.deliveryKey);
  if (delivery === undefined) {
    throw new Error(`legacy statements for ${acceptance.sourceId} were acknowledged unaccepted`);
  }
  acknowledgeReferenceAcceptance(db, {
    ...acceptance,
    knownFrom: stamp.knownFrom,
    observedAckAt: stamp.observedAckAt,
    referenceVersion: delivery.referenceVersion,
  });
  markLedgerApplied(db, statedReferenceKey(acceptance.sourceId), {
    version: pass.statements.version,
  });
}

/**
 * A refused pass keeps the accepted input and never writes the marker: the statements stay owed
 * to whichever pass proves them next.
 */
export function discardLegacyStatements(db: SqliteHandle, pass: LegacyStatementPass): void {
  const acceptance = acceptanceOf(pass);
  if (acceptance !== undefined) {
    discardReferenceAcceptance(db, acceptance);
  }
}
