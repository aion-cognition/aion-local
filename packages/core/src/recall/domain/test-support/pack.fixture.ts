import type { Cue, StageTimingsMs } from '@aion/protocol';

import type { AdmissionEvidence, AdmissionReport } from '../admission.js';
import type { FusedItem } from '../fusion.js';
import type { BucketCaps } from '../pack-buckets.js';
import { assemblePack, type AssemblePackInput } from '../pack.js';

/**
 * The item, report and assembly builders both pack test files run on. They were two copies
 * differing by one override field, so a change to the item shape had to be made twice.
 */

export const TIMINGS: StageTimingsMs = {
  embed: 12,
  cues: 340,
  seeds: 55,
  activation: 80,
  fusion: 4,
};

export const CUES: readonly Cue[] = [{ text: 'webhooks', source: 'query', weight: 3 }];

export const CAPS: BucketCaps = {
  facts: 15,
  episodes: 5,
  narratives: 5,
  intentions: 3,
  preferences: 3,
  resonant: 5,
};

export type ItemOverrides = {
  readonly labels?: readonly string[];
  readonly content?: string;
  readonly score?: number;
  readonly occurredAt?: Date;
  readonly path?: string;
  readonly superseded?: boolean;
  readonly sourceEpisodeId?: string;
  /** The absolute cosine behind admission; zero for an item a literal match let in. */
  readonly measured?: number;
  /** The node's own stated reason, when the fixture wants one. */
  readonly why?: string;
  /** The rule that let the item in, as the gate reports it. */
  readonly admittedBy?: AdmissionEvidence;
};

export function item(id: string, overrides: ItemOverrides = {}): FusedItem {
  const { path } = overrides;
  return {
    id,
    labels: overrides.labels ?? ['Episode', 'Memory', 'AionNode'],
    content: overrides.content ?? `content of ${id}`,
    ...(overrides.occurredAt === undefined ? {} : { occurredAt: overrides.occurredAt }),
    rationale: {
      method: path === undefined ? 'vector' : 'activation',
      score: 0.8,
      ...(path === undefined ? {} : { path }),
    },
    relevance: 0.8,
    measured: overrides.measured ?? 0.8,
    ...(overrides.why === undefined ? {} : { why: overrides.why }),
    ...(overrides.admittedBy === undefined ? {} : { admittedBy: overrides.admittedBy }),
    score: overrides.score ?? 0.02,
    ...(overrides.sourceEpisodeId === undefined
      ? {}
      : { sourceEpisodeId: overrides.sourceEpisodeId }),
    ...(overrides.superseded === true
      ? {
          currency: 'superseded' as const,
          supersededBy: { id: `${id}-successor`, at: new Date('2026-08-10T00:00:00.000Z') },
        }
      : { currency: 'current' as const }),
  };
}

/** A gate that judged exactly the items handed over and dropped nothing, unless a test says otherwise. */
export function report(items: readonly FusedItem[]): AdmissionReport {
  return {
    policy: { vectorFloor: 0.6, corroborationFloor: 0.45, bm25Mode: 'exact' },
    considered: items.length,
    admitted: items.length,
    droppedBelowFloor: 0,
    droppedUnmeasured: 0,
    droppedUnmeasuredArrival: 0,
    droppedDuplicateContent: 0,
    droppedNearDuplicate: 0,
    anchored: items.length > 0,
    typedAdmitted: 0,
  };
}

export function assemble(
  items: readonly FusedItem[],
  overrides: Partial<AssemblePackInput> = {},
): ReturnType<typeof assemblePack> {
  return assemblePack({
    items,
    admission: report(items),
    caps: CAPS,
    tokenBudget: 1200,
    cues: CUES,
    timings: TIMINGS,
    ...overrides,
  });
}
