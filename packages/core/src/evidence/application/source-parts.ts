import type { ExperienceArchiveRow } from '../../infrastructure/sqlite/experience-archive.js';
import type {
  SourcePartRecord,
  SourceRecord,
} from '../../infrastructure/sqlite/source-identity.js';
import { sourcePartsOf } from '../../reflection/application/source-manifest.js';
import { prepareEpisode } from '../../reflection/domain/content.js';
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
    if (
      match?.contentHash !== part.contentHash ||
      (match.role ?? null) !== part.role ||
      (match.occurredAt ?? null) !== part.occurredAt
    ) {
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
