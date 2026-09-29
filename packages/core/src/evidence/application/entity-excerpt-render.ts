import type { EvidenceAddress, SourcePartKind } from '../domain/address.js';
import { ENTITY_EXCERPT_LIMITS } from '../domain/budget.js';
import type { WindowPlacement } from '../domain/excerpt-window.js';

/**
 * What an entity judge is told about the captured text it is shown, and about what it is not.
 *
 * The judge reads a selection, and the text says so: every block names itself as excerpts rather
 * than whole sources, every excerpt names its source, part and position, and every source that
 * was nominated and not shown is counted with the reason. A window placed without a literal match
 * says that too, since the name it was nominated under never appears in it.
 */

/** Why a source was nominated, which is also the order the judge reads them in. */
export type ExcerptNomination = 'prompting' | 'correction' | 'shared' | 'recent';

/** A side of the pair: the subject first, then the candidate. */
export type EntitySide = 0 | 1;

export type SourceExcerpt = {
  readonly sourceId: string;
  readonly sessionId: string;
  /** The source's world clock. */
  readonly occurredAt: string;
  /** The part's own clock, where the capture recorded one. */
  readonly partOccurredAt?: string;
  readonly address: EvidenceAddress;
  readonly partKind: SourcePartKind;
  readonly ordinal: number;
  readonly role?: string;
  /** The manifest digest the decoded part was verified against. */
  readonly partDigest: string;
  /** UTF-16 offsets of the window in the rendered part. */
  readonly start: number;
  readonly end: number;
  readonly partUnits: number;
  /** The window alone, never the part it came from. */
  readonly text: string;
  readonly placement: WindowPlacement;
  readonly nominatedAs: ExcerptNomination;
  /** The sides the committed view records the source against: one, both, or neither yet. */
  readonly sides: readonly EntitySide[];
  readonly currency: 'open' | 'closed';
  /** The stored part this read decoded and was charged for, which is more than the window. */
  readonly decodedRawUtf8Bytes: number;
};

/**
 * Why a nominated source is not shown: disclosure withheld, a naming part too large to verify
 * within bounds, no name spelled in any part and no part small enough to open on instead, a
 * record it could not be verified against, a history the vantage cannot place, or an allowance
 * this pair had already spent.
 */
export type OmissionKind =
  'withheld' | 'oversized' | 'unmatched' | 'unverified' | 'unplaced' | 'spent';

const OMISSION_WORDING: Readonly<Record<OmissionKind, string>> = {
  withheld: 'withheld from disclosure',
  oversized: `whose mention sits only in parts over ${String(ENTITY_EXCERPT_LIMITS.partBytes)} bytes`,
  unmatched: `with no name found in any part and no part within ${String(
    ENTITY_EXCERPT_LIMITS.partBytes,
  )} bytes to show instead`,
  unverified: 'that could not be verified against its record',
  unplaced: 'whose history could not be established at this vantage',
  spent: "past this pair's read or prompt allowance",
};

function sources(count: number): string {
  return `${String(count)} source${count === 1 ? '' : 's'}`;
}

function nominationLabel(excerpt: SourceExcerpt): string {
  if (excerpt.nominatedAs === 'prompting') {
    return excerpt.sides.length === 0
      ? 'prompting episode, recorded against neither entity yet'
      : 'prompting episode';
  }
  return excerpt.nominatedAs === 'correction' ? 'stated correction' : excerpt.nominatedAs;
}

function partLabel(excerpt: SourceExcerpt): string {
  if (excerpt.partKind === 'turn') {
    return excerpt.role === undefined
      ? `turn ${String(excerpt.ordinal)}`
      : `turn ${String(excerpt.ordinal)} (${excerpt.role})`;
  }
  return `${excerpt.partKind === 'observation' ? 'observation' : 'tool execution'} ${String(
    excerpt.ordinal,
  )}`;
}

/** One excerpt as the judge reads it: where it came from, then the captured words. */
export function renderExcerpt(excerpt: SourceExcerpt): string {
  const notes = [
    `[${nominationLabel(excerpt)}] source ${excerpt.sourceId}`,
    `session ${excerpt.sessionId}`,
    `occurred ${excerpt.partOccurredAt ?? excerpt.occurredAt}`,
    partLabel(excerpt),
    `position ${String(excerpt.start)} to ${String(excerpt.end)} of ${String(excerpt.partUnits)}`,
    ...(excerpt.currency === 'closed' ? ['a recorded mention since retired'] : []),
    ...(excerpt.placement.kind === 'no_literal_match'
      ? ['no literal mention of a name was found in it, so this is the start of the part']
      : []),
  ];
  const opening = excerpt.start > 0 ? '…' : '';
  const closing = excerpt.end < excerpt.partUnits ? '…' : '';
  return `${notes.join(', ')}:\n"""\n${opening}${excerpt.text}${closing}\n"""`;
}

function omissionLine(omissions: readonly OmissionKind[]): string | undefined {
  const counted = (Object.keys(OMISSION_WORDING) as OmissionKind[]).flatMap((kind) => {
    const count = omissions.filter((omission) => omission === kind).length;
    return count === 0 ? [] : [`${sources(count)} ${OMISSION_WORDING[kind]}`];
  });
  return counted.length === 0 ? undefined : `Not shown: ${counted.join('; ')}.`;
}

function shownCount(excerpts: readonly SourceExcerpt[]): string {
  const read = new Set(excerpts.map((excerpt) => excerpt.sourceId)).size;
  return `${String(excerpts.length)} excerpt${excerpts.length === 1 ? '' : 's'} from ${sources(read)} shown`;
}

/** One entity's own captured text, the sources it shares with the other entity excluded. */
export function renderSideExcerpts(input: {
  readonly name: string;
  readonly excerpts: readonly SourceExcerpt[];
  readonly omissions: readonly OmissionKind[];
  readonly unreadSourcesRemain: boolean;
}): string {
  const header =
    input.excerpts.length === 0
      ? `No captured text recorded against ${input.name} alone could be shown.`
      : `Captured text recorded against ${input.name}: excerpts, not whole sources. ` +
        `${shownCount(input.excerpts)}: the episode that prompted this comparison and any ` +
        'stated correction first, then the newest captures, one per session before a second. ' +
        'A capture repeated word for word is shown once.';
  const unread = input.unreadSourcesRemain
    ? ['More sources are recorded against it and were not read.']
    : [];
  const omitted = omissionLine(input.omissions);
  return [
    [header, ...unread].join(' '),
    ...input.excerpts.map(renderExcerpt),
    ...(omitted === undefined ? [] : [omitted]),
  ].join('\n');
}

/**
 * The captured text both entities are recorded against, and a prompting episode recorded against
 * neither yet. Each source is read once and shown once, because one exchange naming both is one
 * record rather than a witness for each side.
 */
export function renderSharedExcerpts(input: {
  readonly names: readonly [string, string];
  readonly excerpts: readonly SourceExcerpt[];
  readonly omissions: readonly OmissionKind[];
}): string {
  if (input.excerpts.length === 0 && input.omissions.length === 0) {
    return '';
  }
  const [left, right] = input.names;
  const header =
    `Captured text concerning both ${left} and ${right}: excerpts, not whole sources, each ` +
    'source read once and shown once, one record rather than a witness for each side. ' +
    `${shownCount(input.excerpts)}.`;
  const omitted = omissionLine(input.omissions);
  return [
    header,
    ...input.excerpts.map(renderExcerpt),
    ...(omitted === undefined ? [] : [omitted]),
  ].join('\n');
}
