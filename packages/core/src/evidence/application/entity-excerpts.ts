import { EvidenceDependencies } from './dependencies.js';
import {
  renderSharedExcerpts,
  renderSideExcerpts,
  type EntitySide,
  type OmissionKind,
  type SourceExcerpt,
} from './entity-excerpt-render.js';
import { nominateEntitySources, type EntityNominee } from './entity-nomination.js';
import type {
  ExcerptSide,
  JudgmentAssembly,
  JudgmentDeps,
  JudgmentPair,
  JudgmentSideRequest,
  SharedExcerpts,
} from './judgment.js';
import { archiveProofHolds, gateSource } from './source-gate.js';
import { partHolds, renderPartValue } from './source-parts.js';
import {
  locateArchiveParts,
  readArchivedIdentity,
  readArchivePart,
  type LocatedPart,
  type PartLocation,
} from '../../infrastructure/sqlite/archive-parts.js';
import type { SqliteHandle } from '../../infrastructure/sqlite/database.js';
import { readSourcePart, type SourceRecord } from '../../infrastructure/sqlite/source-identity.js';
import type { CheckedReadContext } from '../../recall/application/coverage-checker.js';
import { idAddress, partAddress, type EvidenceAddress } from '../domain/address.js';
import {
  ENTITY_EXCERPT_LIMITS,
  RENDERED_SIDE_OVERHEAD,
  renderableUnits,
  utf16CodeUnits,
  type RequestBudget,
} from '../domain/budget.js';
import { windowOn } from '../domain/excerpt-window.js';
import type { EvidenceIssue } from '../domain/result.js';

/**
 * The evidence an entity judgment runs on: a bounded, disclosed selection of excerpts from the
 * captured text each entity is recorded against.
 *
 * The contract is that what the judge is shown is faithfully sourced and still applicable, not
 * that it has read the entity's whole history. So each shown excerpt keeps every guarantee a
 * whole read keeps: the source is gated on its records and its disclosure state first, the
 * archive row is held to the record's proof, and the one part shown is decoded and hashed against
 * the digest the writer recorded for it. The revision binds every scope and source consulted, so
 * a forget, a new mention or a new correction before the answer is applied refuses it.
 *
 * The reads are bounded, not only the prompt. One id is charged per source gated, the nomination
 * rows are charged before each read, and each part is charged its stored size before it is
 * decoded, which never exceeds a fixed fraction of the pair's decode allowance. The rest of a
 * payload never reaches this process: SQLite locates the names inside each nominated payload and
 * hands back only coordinates. It does parse those payloads to do so, and that work is bounded by
 * the acceptance limit on one request's size times the seats a pair has.
 *
 * What cannot be shown is named rather than blocking. A withheld source, an unverifiable one, a
 * part too large to verify within bounds, and an allowance already spent are counted in the
 * judge's input and listed in `omitted`. A side abstains only when every source nominated for it
 * is withheld from disclosure, since then nothing can be said about it at all.
 */

type ExcerptRead =
  | { readonly status: 'shown'; readonly excerpts: readonly SourceExcerpt[] }
  | { readonly status: 'omitted'; readonly kind: OmissionKind; readonly issue: EvidenceIssue };

type NomineeRead = {
  readonly nominee: EntityNominee;
  readonly read: ExcerptRead;
  /** A part of a shown source that could not be shown beside the one that was. */
  readonly partIssues: readonly EvidenceIssue[];
};

type Omission = {
  readonly sides: readonly EntitySide[];
  readonly kind: OmissionKind;
};

const SIDES = [0, 1] as const;

function omitted(
  kind: OmissionKind,
  address: EvidenceAddress,
  reason: 'budget_limit' | 'unresolved_mapping',
): ExcerptRead {
  return {
    status: 'omitted',
    kind,
    issue: { address, field: 'source_content', reason, required: false },
  };
}

function gateOmission(issue: EvidenceIssue): OmissionKind {
  if (issue.reason === 'suppressed_source') {
    return 'withheld';
  }
  return issue.reason === 'unsupported_history' || issue.reason === 'not_found'
    ? 'unplaced'
    : 'unverified';
}

/**
 * The literal forms a locate searches for. SQLite folds ASCII case alone, so the other case forms
 * of each name are supplied here rather than missed.
 */
function spellings(names: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const lower = trimmed.toLowerCase();
    forms.add(trimmed);
    forms.add(lower);
    forms.add(trimmed.toUpperCase());
    forms.add(
      lower.replace(
        /(^|\s)(\S)/gu,
        (_, space: string, first: string) => space + first.toUpperCase(),
      ),
    );
  }
  return [...forms];
}

function namesOf(side: JudgmentSideRequest): readonly string[] {
  return side.names === undefined || side.names.length === 0 ? [side.statement] : side.names;
}

/** The parts a source is shown by: where both names meet, else where each is first spelled. */
function chosenParts(location: PartLocation, sides: readonly EntitySide[]): LocatedPart[] {
  const onBoth = sides.length !== 1;
  const bothHits =
    location.together === undefined ? [location.first[0], location.first[1]] : [location.together];
  const hits = onBoth ? bothHits : [location.first[sides[0] ?? 0]];
  const distinct = hits
    .filter((part): part is LocatedPart => part !== undefined)
    .filter(
      (part, index, all) =>
        all.findIndex(
          (other) => other.partKind === part.partKind && other.ordinal === part.ordinal,
        ) === index,
    );
  if (distinct.length > 0) {
    return distinct;
  }
  const oversized = onBoth
    ? location.oversized[0] + location.oversized[1]
    : location.oversized[sides[0] ?? 0];
  // A name spelled only in a part too large to verify is not the same as a name never spelled:
  // showing the opening instead would present an unrelated passage as the mention.
  return oversized > 0 || location.opening === undefined ? [] : [location.opening];
}

/** One pair's reads, sharing the budget, the dependency set and the names both sides go by. */
class ExcerptReader {
  readonly #db: SqliteHandle;
  readonly #context: CheckedReadContext;
  readonly #budget: RequestBudget;
  readonly #dependencies: EvidenceDependencies;
  readonly #names: readonly [readonly string[], readonly string[]];
  readonly #spellings: readonly [readonly string[], readonly string[]];

  constructor(
    deps: JudgmentDeps,
    pair: JudgmentPair,
    context: CheckedReadContext,
    budget: RequestBudget,
    dependencies: EvidenceDependencies,
  ) {
    this.#db = deps.db;
    this.#context = context;
    this.#budget = budget;
    this.#dependencies = dependencies;
    this.#names = [namesOf(pair.sides[0]), namesOf(pair.sides[1])];
    this.#spellings = [spellings(this.#names[0]), spellings(this.#names[1])];
  }

  read(nominee: EntityNominee): NomineeRead {
    const address = idAddress(nominee.sourceId);
    if (this.#budget.chargeIds(1) !== undefined) {
      return { nominee, read: omitted('spent', address, 'budget_limit'), partIssues: [] };
    }
    const gate = gateSource(this.#db, address, {
      use: 'entity_judgment',
      context: this.#context,
      required: false,
    });
    this.#dependencies.addAll(gate.dependencies);
    if (gate.status === 'closed') {
      const issue = gate.issues[0] ?? {
        address,
        field: 'source_content',
        reason: 'unresolved_mapping',
        required: false,
      };
      return {
        nominee,
        read: {
          status: 'omitted',
          kind: gateOmission(issue),
          issue: { ...issue, required: false },
        },
        partIssues: [],
      };
    }
    const { record } = gate;
    const archived =
      record.canonicalArchiveId === null
        ? undefined
        : readArchivedIdentity(this.#db, record.canonicalArchiveId);
    if (archived === undefined || !archiveProofHolds(record, archived)) {
      return {
        nominee,
        read: omitted('unverified', address, 'unresolved_mapping'),
        partIssues: [],
      };
    }
    let location: PartLocation;
    try {
      location = locateArchiveParts(
        this.#db,
        archived.id,
        this.#spellings,
        ENTITY_EXCERPT_LIMITS.partBytes,
      );
    } catch {
      return {
        nominee,
        read: omitted('unverified', address, 'unresolved_mapping'),
        partIssues: [],
      };
    }
    const parts = chosenParts(location, nominee.sides);
    if (parts.length === 0) {
      return { nominee, read: omitted('oversized', address, 'budget_limit'), partIssues: [] };
    }
    const reads = parts.map((part) => this.#readPart(record, archived.id, part, nominee));
    const shown = reads.flatMap((read) => (read.status === 'shown' ? read.excerpts : []));
    const failed = reads.flatMap((read) => (read.status === 'omitted' ? [read] : []));
    const [firstFailure] = failed;
    if (shown.length === 0 && firstFailure !== undefined) {
      return { nominee, read: firstFailure, partIssues: failed.slice(1).map((read) => read.issue) };
    }
    return {
      nominee,
      read: { status: 'shown', excerpts: shown },
      partIssues: failed.map((read) => read.issue),
    };
  }

  /** One part, charged at its stored size, decoded alone and proved against its recorded row. */
  #readPart(
    record: SourceRecord,
    archiveId: string,
    part: LocatedPart,
    nominee: EntityNominee,
  ): ExcerptRead {
    const address = partAddress(record.sourceId, part.partKind, part.ordinal);
    if (this.#budget.chargeRawBytes(part.storedBytes) !== undefined) {
      return omitted('spent', address, 'budget_limit');
    }
    let value: unknown;
    try {
      const json = readArchivePart(this.#db, archiveId, part);
      if (json === undefined) {
        return omitted('unverified', address, 'unresolved_mapping');
      }
      value = JSON.parse(json);
    } catch {
      return omitted('unverified', address, 'unresolved_mapping');
    }
    const stored = readSourcePart(this.#db, record.sourceId, part.partKind, part.ordinal);
    if (stored === undefined || !partHolds(part.partKind, part.ordinal, value, record, stored)) {
      return omitted('unverified', address, 'unresolved_mapping');
    }
    const names =
      nominee.sides.length === 1
        ? this.#names[nominee.sides[0] ?? 0]
        : [...this.#names[0], ...this.#names[1]];
    const window = windowOn(
      renderPartValue(part.partKind, value),
      names,
      ENTITY_EXCERPT_LIMITS.windowUnits,
    );
    return {
      status: 'shown',
      excerpts: [
        {
          sourceId: record.sourceId,
          sessionId: record.sessionId,
          occurredAt: record.occurredAt,
          ...(stored.occurredAt === null ? {} : { partOccurredAt: stored.occurredAt }),
          address,
          partKind: part.partKind,
          ordinal: part.ordinal,
          ...(stored.role === null ? {} : { role: stored.role }),
          partDigest: stored.contentHash,
          start: window.start,
          end: window.end,
          partUnits: window.partUnits,
          text: window.text,
          placement: window.placement,
          nominatedAs: nominee.nominatedAs,
          sides: nominee.sides,
          currency: nominee.currency,
          decodedRawUtf8Bytes: part.storedBytes,
        },
      ],
    };
  }
}

function belongsTo(sides: readonly EntitySide[], side: EntitySide | 'shared'): boolean {
  return side === 'shared' ? sides.length !== 1 : sides.length === 1 && sides[0] === side;
}

type Rendered = {
  readonly sides: readonly [ExcerptSide, ExcerptSide];
  readonly shared?: SharedExcerpts;
  readonly units: number;
};

function rendered(
  pair: JudgmentPair,
  excerpts: readonly SourceExcerpt[],
  omissions: readonly Omission[],
  unread: readonly [boolean, boolean],
): Rendered {
  const kindsFor = (side: EntitySide | 'shared'): OmissionKind[] =>
    omissions
      .filter((omission) => belongsTo(omission.sides, side))
      .map((omission) => omission.kind);
  const sideFor = (side: EntitySide): ExcerptSide => {
    const request = pair.sides[side];
    const own = excerpts.filter((excerpt) => belongsTo(excerpt.sides, side));
    const renderedContext = renderSideExcerpts({
      name: request.statement,
      excerpts: own,
      omissions: kindsFor(side),
      unreadSourcesRemain: unread[side],
    });
    return {
      evidence: 'excerpts',
      nodeId: request.nodeId,
      statement: request.statement,
      excerpts: own,
      unreadSourcesRemain: unread[side],
      renderedContext,
      renderedUnits:
        utf16CodeUnits(request.statement) +
        utf16CodeUnits(renderedContext) +
        RENDERED_SIDE_OVERHEAD,
    };
  };
  const sides = [sideFor(0), sideFor(1)] as const;
  const sharedExcerpts = excerpts.filter((excerpt) => belongsTo(excerpt.sides, 'shared'));
  const sharedContext = renderSharedExcerpts({
    names: [pair.sides[0].statement, pair.sides[1].statement],
    excerpts: sharedExcerpts,
    omissions: kindsFor('shared'),
  });
  const shared =
    sharedContext.length === 0
      ? undefined
      : {
          excerpts: sharedExcerpts,
          renderedContext: sharedContext,
          renderedUnits: utf16CodeUnits(sharedContext) + RENDERED_SIDE_OVERHEAD,
        };
  return {
    sides,
    ...(shared === undefined ? {} : { shared }),
    units: sides.reduce((total, side) => total + side.renderedUnits, shared?.renderedUnits ?? 0),
  };
}

export function assembleEntityEvidence(
  deps: JudgmentDeps,
  pair: JudgmentPair,
  context: CheckedReadContext,
  budget: RequestBudget,
): JudgmentAssembly {
  const dependencies = new EvidenceDependencies();
  const nomination = nominateEntitySources(deps, pair, budget, dependencies);
  if (nomination.status === 'incomplete') {
    return { status: 'incomplete', reasons: nomination.issues, revision: dependencies.revision() };
  }
  const reader = new ExcerptReader(deps, pair, context, budget, dependencies);
  const reads = nomination.nominees.map((nominee) => reader.read(nominee));

  const withheld = reads.flatMap((entry) =>
    entry.read.status === 'omitted' && entry.read.kind === 'withheld' ? [entry] : [],
  );
  const silenced = SIDES.some((side) => {
    const nominated = reads.filter((entry) => entry.nominee.sides.includes(side));
    return nominated.length > 0 && nominated.every((entry) => withheld.includes(entry));
  });
  if (silenced) {
    return {
      status: 'abstained',
      reason: 'required_source_suppressed',
      addresses: withheld.map((entry) =>
        entry.read.status === 'omitted'
          ? entry.read.issue.address
          : idAddress(entry.nominee.sourceId),
      ),
      revision: dependencies.revision(),
    };
  }
  if (nomination.stateIssues.length > 0) {
    return {
      status: 'incomplete',
      reasons: nomination.stateIssues,
      revision: dependencies.revision(),
    };
  }

  const issues: EvidenceIssue[] = reads.flatMap((entry) => [
    ...(entry.read.status === 'omitted' ? [entry.read.issue] : []),
    ...entry.partIssues,
  ]);
  const omissions: Omission[] = reads.flatMap((entry) =>
    entry.read.status === 'omitted' ? [{ sides: entry.nominee.sides, kind: entry.read.kind }] : [],
  );
  // Fit to what the route may still render, dropping from the end: the order is the priority, so
  // the newest captures of the last side go first and the prompting episode goes last.
  const allowance = renderableUnits({ route: pair.route, reservedUnits: pair.reservedUnits });
  let shown = reads.flatMap((entry) => (entry.read.status === 'shown' ? entry.read.excerpts : []));
  let fitted = rendered(pair, shown, omissions, nomination.unreadSourcesRemain);
  while (fitted.units > allowance && shown.length > 0) {
    const dropped = shown[shown.length - 1];
    shown = shown.slice(0, -1);
    if (dropped !== undefined) {
      issues.push({
        address: dropped.address,
        field: 'source_content',
        reason: 'budget_limit',
        required: false,
      });
      if (!shown.some((excerpt) => excerpt.sourceId === dropped.sourceId)) {
        omissions.push({ sides: dropped.sides, kind: 'spent' });
      }
    }
    fitted = rendered(pair, shown, omissions, nomination.unreadSourcesRemain);
  }
  return {
    status: 'assembled',
    sides: fitted.sides,
    ...(fitted.shared === undefined ? {} : { shared: fitted.shared }),
    revision: dependencies.revision(),
    omitted: issues,
  };
}
