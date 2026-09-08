import type {
  CapturedClaim,
  CapturedProposal,
  CapturedSource,
  CapturedArchiveRow,
  CapturedLineageEdge,
  IncidentCapture,
} from './consolidation-incident.fixture.js';
import type {
  FixtureManifest,
  FixtureVariant,
  UnknownField,
  VariantDelta,
} from '../../../introspection/domain/campaign-fixture-manifest.js';

/**
 * The two named fixtures the verified capture is packaged as, and the independence check a
 * reader of them has to pass.
 *
 * They live beside the loader rather than inside it: loading is about bytes and digests, and
 * packaging is about what each variant deliberately changes. One file doing both grew past the
 * size this repository reads comfortably.
 */

export type IncidentFixture = {
  readonly manifest: FixtureManifest;
  readonly claims: readonly CapturedClaim[];
  readonly sources: readonly CapturedSource[];
  readonly lineage: readonly CapturedLineageEdge[];
  readonly archive: readonly CapturedArchiveRow[];
  readonly proposals: readonly CapturedProposal[];
};

/** The earliest closure the capture recorded, which is the line the second variant cuts at. */
function firstClosure(capture: IncidentCapture): string | undefined {
  const stamps = capture.claims
    .map((claim) => claim.validUntil)
    .filter((stamp): stamp is string => stamp !== null)
    .sort();
  return stamps[0];
}

/** Every scalar the capture left null, named rather than defaulted, plus the fields it never held. */
function unknownFieldsOf(capture: IncidentCapture): readonly UnknownField[] {
  const unknown: UnknownField[] = [];
  const claimFields = [
    ['occurredAt', 'occurred_at'],
    ['textNorm', 'text_norm'],
    ['subjectId', 'subject_id'],
    ['aspect', 'aspect'],
    ['sourceEpisodeId', 'source_episode_id'],
    ['sessionId', 'session_id'],
    ['extractionMethod', 'extraction_method'],
    ['txFrom', 'tx_from'],
  ] as const;
  for (const claim of capture.claims) {
    for (const [key, field] of claimFields) {
      if (claim[key] === null) {
        unknown.push({ subject: claim.id, field });
      }
    }
  }
  for (const source of capture.sources) {
    if (source.summary === null) {
      unknown.push({ subject: source.episodeId, field: 'summary' });
    }
    if (source.txFrom === null) {
      unknown.push({ subject: source.episodeId, field: 'tx_from' });
    }
    if (source.edgeCreatedAt === null) {
      unknown.push({ subject: source.episodeId, field: 'extraction_edge_created_at' });
    }
  }
  for (const edge of capture.lineage) {
    if (edge.createdAt === null) {
      unknown.push({ subject: `${edge.predecessorId}->${edge.successorId}`, field: 'created_at' });
    }
  }
  // The capture holds no Turn identities and no archive content hash or schema version, and
  // the request that produced the closure was never recorded anywhere.
  for (const row of capture.archive) {
    unknown.push({ subject: row.id, field: 'schema_version' });
    unknown.push({ subject: row.id, field: 'content_hash' });
    for (const [index, turn] of (row.payload.turns ?? []).entries()) {
      unknown.push({ subject: `${row.episodeId}#${String(index)}`, field: 'turn_id' });
      if (turn.occurred_at === undefined) {
        unknown.push({ subject: `${row.episodeId}#${String(index)}`, field: 'turn_occurred_at' });
      }
    }
  }
  for (const proposal of capture.proposals) {
    unknown.push({ subject: proposal.id, field: 'submitted_prompt' });
    if (proposal.rationale === null) {
      unknown.push({ subject: proposal.id, field: 'rationale' });
    }
  }
  return unknown;
}

/**
 * Held back from every variant, so no field leaves the capture without a line saying so. The
 * stored vectors are floats taken over text the fixture already carries; a case about them
 * re-embeds rather than replays, and carrying two 1024-float arrays per node would make the
 * fixture unreadable.
 */
function sharedExclusions(capture: IncidentCapture): readonly VariantDelta[] {
  return capture.claims.map((claim) => ({
    kind: 'excluded_stamp' as const,
    subject: claim.id,
    reason: 'stored content and context vectors are held back from every variant',
  }));
}

function originalIds(capture: IncidentCapture): Readonly<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [index, claim] of capture.claims.entries()) {
    ids[`claim_${String(index)}`] = claim.id;
  }
  for (const [index, source] of capture.sources.entries()) {
    ids[`source_${String(index)}`] = source.episodeId;
  }
  for (const [index, row] of capture.archive.entries()) {
    ids[`archive_${String(index)}`] = row.id;
  }
  for (const [index, proposal] of capture.proposals.entries()) {
    ids[`proposal_${String(index)}`] = proposal.id;
  }
  return ids;
}

/**
 * Packages one named variant.
 *
 * `incident-snapshot` keeps the observed state exactly, wrong semantics included: a migration
 * has to carry the erroneous closure across until a correction operation changes it, and a
 * fixture that quietly repaired it would let that go untested.
 *
 * `isolated-before-judgment` rewinds to before the first recorded closure and lists every edge,
 * stamp and proposal it left out. It exercises prevention, and its manifest says so, because
 * the request the live run actually submitted was never recorded and nothing here reconstructs
 * it.
 */
export function packageIncidentFixture(
  capture: IncidentCapture,
  variant: FixtureVariant,
): IncidentFixture {
  const shared = {
    archive: capture.archive,
    sources: capture.sources,
  };
  const base = {
    manifestVersion: 1,
    capturedAt: capture.observedAt,
    sourceArtifacts: capture.artifacts,
    unknownFields: unknownFieldsOf(capture),
    originalIds: originalIds(capture),
  };

  if (variant === 'incident-snapshot') {
    return {
      ...shared,
      claims: capture.claims,
      lineage: capture.lineage,
      proposals: capture.proposals,
      manifest: {
        ...base,
        variant,
        classification: 'the observed false supersession, closures and proposal included',
        deltas: sharedExclusions(capture),
        expectedAssertions: [
          'the erroneous closure survives a migration until a correction operation changes it',
          'both recorded closures of the same claim are preserved',
          'the claim keeps the occurrence clock the capture recorded',
        ],
      },
    };
  }

  const closure = firstClosure(capture);
  const deltas: VariantDelta[] = [...sharedExclusions(capture)];
  for (const edge of capture.lineage) {
    deltas.push({
      kind: 'excluded_edge',
      subject: `${edge.predecessorId}->${edge.successorId}`,
      reason: 'recorded at or after the first closure',
    });
  }
  for (const claim of capture.claims) {
    if (claim.validUntil !== null) {
      deltas.push({
        kind: 'excluded_stamp',
        subject: claim.id,
        reason: `valid_until ${claim.validUntil} was written at the closure this variant rewinds past`,
      });
    }
    if (claim.txUntil !== null) {
      deltas.push({
        kind: 'excluded_stamp',
        subject: claim.id,
        reason: `tx_until ${claim.txUntil} was written at the same closure`,
      });
    }
  }
  for (const proposal of capture.proposals) {
    deltas.push({
      kind: 'excluded_proposal',
      subject: proposal.id,
      reason: 'raised by the judgment this variant exists to test',
    });
  }

  return {
    ...shared,
    claims: capture.claims.map((claim) => ({ ...claim, validUntil: null, txUntil: null })),
    lineage: [],
    proposals: [],
    manifest: {
      ...base,
      variant,
      classification:
        closure === undefined
          ? 'the captured sources and claims, with no closure recorded'
          : `the captured sources and claims as they stood before ${closure}`,
      deltas,
      expectedAssertions: [
        'the two claims stand together, and neither closes the other',
        'a judgment over this pair is what the fixture exercises, not the unrecorded live request',
      ],
    },
  };
}

export type IndependentReader =
  | { readonly status: 'independent'; readonly sessionId: string }
  | { readonly status: 'rejected'; readonly reason: 'resolves_to_source_session' };

/**
 * Whether a reader asking about this incident is a different reader from the ones that wrote
 * it. Resolution goes through the session manager rather than through the identity string,
 * because an alias that resolves to a source session is that session asking about itself, and
 * a recall measured that way is measuring a session reading its own record.
 */
export function independentReaderSession(
  sessions: { sessionIdFor: (identity: string) => string },
  identity: string,
  capture: IncidentCapture,
): IndependentReader {
  const sessionId = sessions.sessionIdFor(identity);
  const sources = new Set([
    ...capture.sources.map((source) => source.sessionId),
    ...capture.archive.map((row) => row.sessionId),
    ...capture.archive.map((row) => row.identity),
  ]);
  if (sources.has(sessionId)) {
    return { status: 'rejected', reason: 'resolves_to_source_session' };
  }
  return { status: 'independent', sessionId };
}
