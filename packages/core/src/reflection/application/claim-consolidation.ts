import type { Driver } from 'neo4j-driver';

import { synthesizeGrounded } from './consolidation-synthesis.js';
import { attachContentVectors } from './vectors.js';
import { DEFAULTS } from '../../infrastructure/config/defaults.js';
import {
  supersede,
  writeStampedDerivedNodeInTransaction,
} from '../../infrastructure/graph/bitemporal.js';
import {
  CONSOLIDATION_EXTRACTION_METHOD,
  findConsolidationByCoverageKey,
  loadCommunityClaims,
  readClaimCommunityProfiles,
  type ClaimCommunityProfile,
  type ConsolidationCandidate,
} from '../../infrastructure/graph/claim-consolidation-queries.js';
import { inWriteTransaction } from '../../infrastructure/graph/connection.js';
import { upsertEdgeInTransaction } from '../../infrastructure/graph/edges.js';
import { MEMORY_PROPERTIES } from '../../infrastructure/graph/episodes.js';
import {
  DERIVES_FROM_TYPE,
  NARRATIVE_PROPERTIES,
} from '../../infrastructure/graph/narrative-queries.js';
import type { GraphProperties } from '../../infrastructure/graph/values.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { Provider } from '../../infrastructure/providers/types.js';
import {
  buildSubjectMessages,
  consolidationNodeId,
  derivedDensityFloor,
  MIN_CONSOLIDATION_MEMBERS,
  renderConsolidationSource,
  type ConsolidationMember,
} from '../domain/consolidation.js';
import { coverageKey, narrativeSpan, NARRATIVE_GROUNDING } from '../domain/narrative.js';

/**
 * The subject axis. Many standing claims across many sessions describe one thing, each written
 * by the episode that happened to mention it, and a pack that serves all of them spends its
 * budget saying one thing several times. This synthesizes the one higher-order claim they add up
 * to, with the grounding a narrative carries: every sentence cites the claims it came from, a
 * `DERIVES_FROM` edge spans each source, and the sources close into it.
 *
 * The output is a claim, not a story. It carries the ordinary fact labels, enters recall in the
 * facts bucket, and can be superseded, keyed and deduped like anything else extraction writes.
 *
 * Candidates come from the community projection, which is the only structure that says two
 * claims are about one subject without a vector deciding it. How dense a neighbourhood has to be
 * is read off the substrate's own community sizes at run time: the reset made every hand-picked
 * number moot, and a graph with no communities at all has no floor to derive, which is an answer
 * rather than a failure.
 */

const CONSOLIDATION_SIGNALS = ['compression'];
const CONSOLIDATION_PROVENANCE = [CONSOLIDATION_EXTRACTION_METHOD];

/** The label a consolidated claim takes: it is an interpretation over claims, which is an insight. */
const CONSOLIDATION_LABEL = 'Insight';

/** Neighbourhoods one run compresses. Each is two model calls, and the sweep runs every hour. */
export const DEFAULT_CONSOLIDATION_SUBJECTS = 1;

/** Claims one neighbourhood contributes. Past this the prompt is longer than a compression is worth. */
export const DEFAULT_CONSOLIDATION_MEMBERS = 24;

/** Distinct sessions a neighbourhood must span: one session restating itself is dedup's work, not this. */
export const CONSOLIDATION_MIN_SESSIONS = 2;

export type ConsolidationDeps = {
  readonly driver: Driver;
  readonly provider: Provider;
  readonly logger: Logger;
};

export type ConsolidationOptions = {
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly subjectLimit?: number;
  readonly memberLimit?: number;
  readonly maxMemberChars?: number;
  readonly now?: Date;
  readonly signal?: AbortSignal;
};

export type ConsolidationReport = {
  /** Neighbourhoods at or above the derived floor, which bounds what the run could have written. */
  readonly candidates: number;
  readonly created: number;
  readonly skipped: number;
  readonly vetoed: number;
  readonly failed: number;
  readonly absorbed: number;
  /** The floor this run derived, absent when the distribution held nothing to derive one from. */
  readonly densityFloor?: number;
  readonly detail: string;
};

type ConsolidationSettings = {
  readonly model: string;
  readonly timeoutMs: number;
  readonly subjectLimit: number;
  readonly memberLimit: number;
  readonly maxMemberChars: number;
  readonly now: Date;
  readonly signal?: AbortSignal;
};

function settingsOf(options: ConsolidationOptions): ConsolidationSettings {
  return {
    model: options.model ?? DEFAULTS.models.reflect,
    timeoutMs: options.timeoutMs ?? DEFAULTS.reflection.stageTimeoutMs,
    subjectLimit: options.subjectLimit ?? DEFAULT_CONSOLIDATION_SUBJECTS,
    memberLimit: options.memberLimit ?? DEFAULT_CONSOLIDATION_MEMBERS,
    maxMemberChars: options.maxMemberChars ?? DEFAULTS.reflection.maxNarrativeEpisodeChars,
    now: options.now ?? new Date(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function toMembers(claims: readonly ConsolidationCandidate[]): readonly ConsolidationMember[] {
  return claims.map((claim) => ({
    id: claim.id,
    kind: claim.label.toLowerCase(),
    text: claim.text,
    ...(claim.occurredAt === undefined ? {} : { occurredAt: claim.occurredAt }),
  }));
}

type ConsolidationWrite = {
  readonly claimId: string;
  readonly memberIds: readonly string[];
  readonly coverageKey: string;
  readonly summary: string;
  readonly text: string;
  readonly citations: readonly string[];
  readonly sentenceCount: number;
  readonly spanStart?: Date;
  readonly spanEnd?: Date;
  readonly occurredAt: Date;
  readonly now: Date;
};

function consolidationProperties(input: ConsolidationWrite): GraphProperties {
  return {
    [MEMORY_PROPERTIES.text]: input.text,
    [MEMORY_PROPERTIES.summary]: input.summary,
    [MEMORY_PROPERTIES.extractionMethod]: CONSOLIDATION_EXTRACTION_METHOD,
    [NARRATIVE_PROPERTIES.citations]: [...input.citations],
    [NARRATIVE_PROPERTIES.sentenceCount]: input.sentenceCount,
    [NARRATIVE_PROPERTIES.grounding]: NARRATIVE_GROUNDING,
    [NARRATIVE_PROPERTIES.coverageKey]: input.coverageKey,
    [NARRATIVE_PROPERTIES.coverageCount]: input.memberIds.length,
    [NARRATIVE_PROPERTIES.spanStart]: input.spanStart,
    [NARRATIVE_PROPERTIES.spanEnd]: input.spanEnd,
  };
}

/**
 * The claim and its provenance in one transaction. `DERIVES_FROM` runs from the consolidation to
 * each source, which is the direction a narrative already uses for the thing it was compressed
 * out of, and it carries count 0 because a repeated write is not a repeated observation.
 */
async function writeConsolidation(
  deps: ConsolidationDeps,
  input: ConsolidationWrite,
): Promise<void> {
  await inWriteTransaction(deps.driver, async (tx) => {
    await writeStampedDerivedNodeInTransaction(tx, {
      label: CONSOLIDATION_LABEL,
      id: input.claimId,
      now: input.now,
      occurredAt: input.occurredAt,
      properties: consolidationProperties(input),
    });

    for (const memberId of input.memberIds) {
      await upsertEdgeInTransaction(tx, {
        type: DERIVES_FROM_TYPE,
        sourceId: input.claimId,
        targetId: memberId,
        strength: 1,
        confidence: 1,
        signals: CONSOLIDATION_SIGNALS,
        provenance: CONSOLIDATION_PROVENANCE,
        count: 0,
        now: input.now,
      });
    }
  });
}

/**
 * The members close into the claim that absorbed them. Ordinary supersession: the lineage is
 * readable, `as_of` still returns them, and `aion unsupersede` reopens any one of them.
 */
async function closeMembers(
  deps: ConsolidationDeps,
  claimId: string,
  memberIds: readonly string[],
  now: Date,
  validUntil: Date,
): Promise<number> {
  let closed = 0;
  for (const memberId of memberIds) {
    if (memberId === claimId) {
      continue;
    }
    await supersede(deps.driver, {
      oldId: memberId,
      newId: claimId,
      now,
      validUntil,
      signals: CONSOLIDATION_SIGNALS,
      provenance: CONSOLIDATION_PROVENANCE,
    });
    closed += 1;
  }
  return closed;
}

async function attachVector(deps: ConsolidationDeps, claimId: string, text: string): Promise<void> {
  try {
    await attachContentVectors(deps.driver, deps.provider, [{ id: claimId, text }]);
  } catch (err) {
    deps.logger.warn({ err, claimId }, 'consolidation vector deferred; the claim is stored');
  }
}

type SubjectOutcome = {
  readonly outcome: 'created' | 'skipped' | 'vetoed' | 'failed';
  readonly absorbed: number;
};

async function consolidateSubject(
  deps: ConsolidationDeps,
  settings: ConsolidationSettings,
  profile: ClaimCommunityProfile,
): Promise<SubjectOutcome> {
  const claims = await loadCommunityClaims(deps.driver, profile.community, settings.memberLimit);
  if (claims.length < MIN_CONSOLIDATION_MEMBERS) {
    return { outcome: 'skipped', absorbed: 0 };
  }

  const memberIds = claims.map((claim) => claim.id);
  const key = coverageKey(memberIds);
  const claimId = consolidationNodeId(key);
  const span = narrativeSpan(claims);
  const occurredAt = span.end ?? settings.now;

  const stored = await findConsolidationByCoverageKey(deps.driver, key);
  if (stored.length > 0) {
    // The set is already consolidated. What can still be missing is the close a crash landed
    // between: `coalesce` makes re-closing a member that is already closed a no-op.
    const open = stored.find((row) => row.open);
    if (open !== undefined) {
      await closeMembers(deps, open.id, memberIds, settings.now, occurredAt);
    }
    return { outcome: 'skipped', absorbed: 0 };
  }

  const source = renderConsolidationSource(toMembers(claims), settings.maxMemberChars);
  const synthesis = await synthesizeGrounded(deps.provider, source, buildSubjectMessages(source), {
    model: settings.model,
    timeoutMs: settings.timeoutMs,
    ...(settings.signal === undefined ? {} : { signal: settings.signal }),
  });

  if (synthesis.status === 'vetoed') {
    deps.logger.info(
      { community: profile.community, members: claims.length, reason: synthesis.reason },
      'consolidation vetoed by review; the source claims stand',
    );
    return { outcome: 'vetoed', absorbed: 0 };
  }
  if (synthesis.status === 'failed') {
    deps.logger.warn(
      { community: profile.community, detail: synthesis.detail },
      'consolidation synthesis failed',
    );
    return { outcome: 'failed', absorbed: 0 };
  }

  await writeConsolidation(deps, {
    claimId,
    memberIds,
    coverageKey: key,
    summary: synthesis.grounded.summary,
    text: synthesis.grounded.narrative,
    citations: synthesis.grounded.citations,
    sentenceCount: synthesis.grounded.kept,
    ...(span.start === undefined ? {} : { spanStart: span.start }),
    ...(span.end === undefined ? {} : { spanEnd: span.end }),
    occurredAt,
    now: settings.now,
  });

  const absorbed = await closeMembers(deps, claimId, memberIds, settings.now, occurredAt);
  await attachVector(deps, claimId, synthesis.grounded.narrative);

  deps.logger.info(
    {
      community: profile.community,
      claimId,
      members: memberIds.length,
      sentences: synthesis.grounded.kept,
      citations: synthesis.grounded.citations.length,
      absorbed,
    },
    'consolidated claim stored',
  );
  return { outcome: 'created', absorbed };
}

/**
 * One pass over the subject axis. A young substrate answers `nothing to consolidate` twice over:
 * no communities have been projected yet, and the ones that appear first are single claims. Both
 * are the designed behaviour rather than a gate, and the operation is armed through either.
 */
export async function consolidateClaims(
  deps: ConsolidationDeps,
  options: ConsolidationOptions = {},
): Promise<ConsolidationReport> {
  const settings = settingsOf(options);
  const profiles = await readClaimCommunityProfiles(deps.driver);
  const floor = derivedDensityFloor(profiles.map((profile) => profile.size));

  if (floor === undefined) {
    return {
      candidates: 0,
      created: 0,
      skipped: 0,
      vetoed: 0,
      failed: 0,
      absorbed: 0,
      detail: 'no claim carries a community assignment, so no density floor can be derived',
    };
  }

  const candidates = profiles
    .filter((profile) => profile.size >= floor && profile.sessions >= CONSOLIDATION_MIN_SESSIONS)
    .slice(0, settings.subjectLimit);

  let created = 0;
  let skipped = 0;
  let vetoed = 0;
  let failed = 0;
  let absorbed = 0;

  for (const profile of candidates) {
    if (settings.signal?.aborted === true) {
      break;
    }
    const result = await consolidateSubject(deps, settings, profile);
    absorbed += result.absorbed;
    if (result.outcome === 'created') {
      created += 1;
    } else if (result.outcome === 'skipped') {
      skipped += 1;
    } else if (result.outcome === 'vetoed') {
      vetoed += 1;
    } else {
      failed += 1;
    }
  }

  return {
    candidates: candidates.length,
    created,
    skipped,
    vetoed,
    failed,
    absorbed,
    densityFloor: floor,
    detail:
      `density floor ${String(floor)} derived from ${String(profiles.length)} neighbourhood(s): ` +
      `${String(candidates.length)} at or above it, ${String(created)} consolidated over ` +
      `${String(absorbed)} claim(s), ${String(skipped)} already covered, ${String(vetoed)} vetoed by ` +
      `review, ${String(failed)} generation failure(s)`,
  };
}
