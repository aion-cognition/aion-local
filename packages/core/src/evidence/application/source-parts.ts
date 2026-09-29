import type { ReflectionTurn, ToolExecution } from '@aion/protocol';

import type { ExperienceArchiveRow } from '../../infrastructure/sqlite/experience-archive.js';
import type {
  SourcePartInput,
  SourcePartRecord,
  SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { sourcePartOf, sourcePartsOf } from '../../reflection/application/source-manifest.js';
import { prepareEpisode, renderToolExecution } from '../../reflection/domain/content.js';
import { partAddress, type EvidenceAddress, type SourcePartKind } from '../domain/address.js';
import type { EvidenceIssue } from '../domain/result.js';

/** Whether the parts a source recorded are the parts its archived payload holds, whole. */

function issueOn(
  address: EvidenceAddress,
  field: EvidenceIssue['field'],
  reason: Exclude<EvidenceIssue['reason'], 'unsupported_history'>,
  required: boolean,
): EvidenceIssue {
  return { address, field, reason, required };
}

/** A part as the episode text renders it, so a part read and a whole read show the same words. */
export function renderPartValue(kind: SourcePartKind, value: unknown): string {
  if (kind === 'turn') {
    const turn = value as ReflectionTurn;
    return `${turn.role}: ${turn.text}`;
  }
  if (kind === 'observation') {
    return `observation: ${value as string}`;
  }
  return renderToolExecution(value as ToolExecution).join('\n');
}

/** Whether a derived part agrees with its recorded row on content, attribution and clock. */
export function partMatchesRecord(
  derived: SourcePartInput | undefined,
  stored: SourcePartRecord,
): boolean {
  return (
    derived?.contentHash === stored.contentHash &&
    (derived.role ?? null) === stored.role &&
    (derived.occurredAt ?? null) === stored.occurredAt
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One decoded part against its recorded row, for a reader that decodes nothing else.
 *
 * The row's content hash is what the writer computed from this part alone, so the part can be
 * proved without the rest of the payload. A turn with no clock of its own takes the source's
 * recorded occurrence, which is the episode clock the writer gave it. What this does not prove is
 * that the manifest is whole; a reader citing one part does not rest on the others.
 */
export function partHolds(
  kind: SourcePartKind,
  ordinal: number,
  value: unknown,
  record: SourceRecord,
  stored: SourcePartRecord,
): boolean {
  const shaped =
    kind === 'observation'
      ? typeof value === 'string'
      : isRecord(value) && (kind !== 'turn' || typeof value.role === 'string');
  return (
    shaped &&
    stored.partKind === kind &&
    stored.ordinal === ordinal &&
    partMatchesRecord(sourcePartOf(kind, ordinal, value, new Date(record.occurredAt)), stored)
  );
}

/**
 * The recorded parts against the derivation the writer used, whole.
 *
 * Every part the archive holds has to have a row, every row has to name a part the archive holds,
 * and each has to agree on its content, its attribution and its clock. Comparing only the rows
 * that exist proves a subset: a deleted row would leave the source certified on what was left,
 * and a rewritten role or occurrence would pass under an unchanged content hash. Each
 * disagreement is named at its own address, so two parts of one source stay two answers.
 */
export function verifyParts(
  row: ExperienceArchiveRow,
  record: SourceRecord,
  stored: readonly SourcePartRecord[],
  request: { readonly required: boolean },
): readonly EvidenceIssue[] {
  const derived = sourcePartsOf(
    prepareEpisode(row.payload, new Date(record.occurredAt)),
    row.payload,
    stored
      .filter((part) => part.partKind === 'turn')
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((part) => part.turnId ?? ''),
  );
  const key = (partKind: string, ordinal: number): string => `${partKind}:${String(ordinal)}`;
  const byKey = new Map(derived.map((part) => [key(part.partKind, part.ordinal), part]));
  const seen = new Set<string>();
  const issues: EvidenceIssue[] = [];
  const mismatch = (partKind: string, ordinal: number): void => {
    issues.push(
      issueOn(
        partAddress(record.sourceId, partKind as SourcePartKind, ordinal),
        'source_content',
        'unresolved_mapping',
        request.required,
      ),
    );
  };

  for (const part of stored) {
    const identity = key(part.partKind, part.ordinal);
    const match = byKey.get(identity);
    if (seen.has(identity)) {
      mismatch(part.partKind, part.ordinal);
      continue;
    }
    seen.add(identity);
    if (!partMatchesRecord(match, part)) {
      mismatch(part.partKind, part.ordinal);
      continue;
    }
    // A turn is the one part kind the projection gave a graph identity. Without the recorded id
    // the address it was cited under cannot be resolved, so the mapping is not proved whole even
    // though the bytes behind it still are.
    if (part.partKind === 'turn' && part.turnId === null) {
      mismatch(part.partKind, part.ordinal);
    }
  }
  // A part the archive holds and the manifest never recorded is not addressable, and a source
  // whose parts are incompletely recorded is not one this read can certify.
  for (const part of derived) {
    if (!seen.has(key(part.partKind, part.ordinal))) {
      mismatch(part.partKind, part.ordinal);
    }
  }
  return issues;
}
